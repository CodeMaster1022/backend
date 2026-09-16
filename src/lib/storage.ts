import { v2 as cloudinary } from "cloudinary";

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

export async function putObject(params: {
  key: string;
  body: Buffer;
  mimeType: string;
}) {
  const dataUri = `data:${params.mimeType};base64,${params.body.toString("base64")}`;
  await cloudinary.uploader.upload(dataUri, {
    public_id: params.key,
    resource_type: "raw",
    type: "private",
    overwrite: true,
    invalidate: true,
    unique_filename: false,
    use_filename: false,
  });
  return { key: params.key, mimeType: params.mimeType };
}

export async function getObject(key: string): Promise<Buffer> {
  // Private delivery — the signed URL is generated and fetched server-side only;
  // it is never handed to the browser, so document access stays gated entirely
  // by the permission checks in routes/documents.ts, not by a guessable Cloudinary URL.
  const url = cloudinary.utils.private_download_url(key, "", {
    resource_type: "raw",
    type: "private",
    attachment: false,
  });
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Cloudinary fetch failed for "${key}": ${res.status} ${res.statusText}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

export function safeKey(parts: string[]) {
  return parts.map((part) => part.replace(/[^a-zA-Z0-9._-]/g, "_")).join("/");
}
