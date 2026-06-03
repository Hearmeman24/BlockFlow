export async function uploadToTmpfiles(file: File): Promise<string> {
  const buf = await file.arrayBuffer()
  const res = await fetch('/api/blocks/upload_image_to_tmpfiles/upload', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Filename': file.name,
      'X-Content-Type': file.type || 'image/png',
    },
    body: buf,
  })
  const data = await res.json()
  if (!data.ok || !data.image_url) throw new Error(data.error || 'upload failed')
  return data.image_url as string
}
