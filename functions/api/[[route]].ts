import { Hono } from 'hono'
import { handle } from 'hono/cloudflare-pages'
import { basicAuth } from 'hono/basic-auth'
import { AwsClient } from 'aws4fetch'

type Bindings = {
  AUTH_USER: string
  AUTH_PASSWORD: string
  S3_ENDPOINT: string
  S3_BUCKET_NAME: string
  S3_ACCESS_KEY_ID: string
  S3_SECRET_ACCESS_KEY: string
  S3_REGION: string
  S3_PUBLIC_DOMAIN?: string
}

interface FileItem {
  key: string
  isFolder: boolean
  uploaded?: string
  size?: number
  url?: string
}

const app = new Hono<{ Bindings: Bindings }>()
const api = app.basePath('/api')

const getS3Client = (env: Bindings) => {
  return new AwsClient({
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    service: 's3',
    region: env.S3_REGION || 'auto',
  })
}

// === MIME 类型映射表 ===
function getMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'mp4': return 'video/mp4';
    case 'webm': return 'video/webm';
    case 'mov': return 'video/quicktime';
    case 'mkv': return 'video/x-matroska';
    case 'avi': return 'video/x-msvideo';
    case 'mp3': return 'audio/mpeg';
    case 'wav': return 'audio/wav';
    case 'm4a': return 'audio/mp4';
    case 'aac': return 'audio/aac';
    case 'jpg': case 'jpeg': return 'image/jpeg';
    case 'png': return 'image/png';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    case 'svg': return 'image/svg+xml';
    case 'pdf': return 'application/pdf';
    case 'txt': return 'text/plain';
    case 'html': return 'text/html';
    case 'css': return 'text/css';
    case 'js': return 'text/javascript';
    case 'json': return 'application/json';
    default: return 'application/octet-stream';
  }
}

// 鉴权
api.use('/*', async (c, next) => {
  const auth = basicAuth({ username: c.env.AUTH_USER, password: c.env.AUTH_PASSWORD })
  return auth(c, next)
})

// === API 1: 获取列表  ===
api.get('/list', async (c) => {
  const client = getS3Client(c.env)
  const prefix = c.req.query('prefix') || ''
  const url = new URL(`${c.env.S3_ENDPOINT}/${c.env.S3_BUCKET_NAME}`)
  url.searchParams.set('list-type', '2')
  url.searchParams.set('prefix', prefix)
  url.searchParams.set('delimiter', '/')
  
  const res = await client.fetch(url.toString())
  if (!res.ok) return c.json({ error: 'S3 Error' }, 500)

  const xml = await res.text()
  const files: FileItem[] = []
  const folders: FileItem[] = []

  const prefixBlocks = xml.split('<CommonPrefixes>')
  for (let i = 1; i < prefixBlocks.length; i++) {
    const pMatch = prefixBlocks[i].match(/<Prefix>(.*?)<\/Prefix>/)
    if (pMatch && pMatch[1]) folders.push({ key: pMatch[1], isFolder: true, size: 0, uploaded: '-' })
  }

  const contentBlocks = xml.split('<Contents>')
  for (let i = 1; i < contentBlocks.length; i++) {
    const block = contentBlocks[i];
    const keyMatch = block.match(/<Key>(.*?)<\/Key>/);
    const sizeMatch = block.match(/<Size>(.*?)<\/Size>/);
    const timeMatch = block.match(/<LastModified>(.*?)<\/LastModified>/);

    if (keyMatch) {
        const key = keyMatch[1];
        if (key === prefix) continue; 
        const accessUrl = c.env.S3_PUBLIC_DOMAIN ? `${c.env.S3_PUBLIC_DOMAIN}/${key}` : `/api/file/${key}`
        files.push({
            key: key,
            isFolder: false,
            uploaded: timeMatch ? timeMatch[1] : new Date().toISOString(),
            size: sizeMatch ? parseInt(sizeMatch[1]) : 0,
            url: accessUrl
        })
    }
  }
  return c.json([...folders, ...files])
})

// === API 2: 上传文件  ===
api.put('/upload', async (c) => {
  let key = c.req.header('x-file-name')
  if (!key) return c.text('No filename provided', 400)
  if (key.startsWith('/')) key = key.substring(1);

  const client = getS3Client(c.env)
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  const url = `${c.env.S3_ENDPOINT}/${c.env.S3_BUCKET_NAME}/${encodedKey}`
  
  // 1. 优先使用后端判断的 MIME 类型
  const mimeType = getMimeType(key);
  
  const res = await client.fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': mimeType, // 强制写入正确的类型到 S3/R2
      'Content-Length': c.req.header('content-length') || '',
      'x-amz-acl': 'public-read'
    },
    body: c.req.raw.body
  })

  if (!res.ok) return c.json({ success: false, error: await res.text() }, 500)
  return c.json({ success: true })
})

// === API 3: 删除 ===
api.delete('/delete', async (c) => {
  const key = c.req.query('key')
  if (!key) return c.text('No key provided', 400)
  const client = getS3Client(c.env)
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  const url = `${c.env.S3_ENDPOINT}/${c.env.S3_BUCKET_NAME}/${encodedKey}`
  const res = await client.fetch(url, { method: 'DELETE' })
  if (!res.ok) return c.json({ success: false }, 500)
  return c.json({ success: true })
})

// === API 4: 代理下载/预览 ===
api.get('/file/:key{.+}', async (c) => {
  const key = c.req.param('key')
  const client = getS3Client(c.env)
  
  let cleanKey = key;
  if (cleanKey.startsWith('/')) cleanKey = cleanKey.substring(1);
  const encodedKey = cleanKey.split('/').map(encodeURIComponent).join('/');
  
  const url = `${c.env.S3_ENDPOINT}/${c.env.S3_BUCKET_NAME}/${encodedKey}`
  
  const range = c.req.header('range')
  const headers: Record<string, string> = {}
  if (range) headers['Range'] = range

  const res = await client.fetch(url, { method: 'GET', headers: headers })
  if (!res.ok) return c.text('Not Found', 404)

  const newHeaders = new Headers(res.headers)
  newHeaders.delete('x-amz-request-id')
  newHeaders.delete('x-amz-id-2')
  
  // 强制修正预览头
  const mimeType = getMimeType(cleanKey);
  newHeaders.set('Content-Type', mimeType);
  newHeaders.set('Content-Disposition', 'inline'); // 关键：允许在线播放
  newHeaders.set('Access-Control-Allow-Origin', '*')

  return new Response(res.body, { status: res.status, headers: newHeaders })
})

export const onRequest = handle(app)