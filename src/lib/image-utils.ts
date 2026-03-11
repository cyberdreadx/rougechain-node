const LOGO_MAX_DIM = 256;
const LOGO_MAX_BYTES = 100 * 1024; // 100 KB max for on-chain storage

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/**
 * Compress an image file to a square webp suitable for a token logo,
 * then return a data URI (data:image/webp;base64,...) ready for on-chain storage.
 */
export async function fileToLogoDataUri(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new Error("File must be an image");
  }

  const bitmap = await createImageBitmap(file);
  const dim = Math.min(bitmap.width, bitmap.height, LOGO_MAX_DIM);

  const canvas = new OffscreenCanvas(dim, dim);
  const ctx = canvas.getContext("2d")!;

  // Center-crop to square
  const srcSize = Math.min(bitmap.width, bitmap.height);
  const sx = (bitmap.width - srcSize) / 2;
  const sy = (bitmap.height - srcSize) / 2;
  ctx.drawImage(bitmap, sx, sy, srcSize, srcSize, 0, 0, dim, dim);
  bitmap.close();

  for (const quality of [0.85, 0.7, 0.5, 0.3]) {
    const blob = await canvas.convertToBlob({ type: "image/webp", quality });
    if (blob.size <= LOGO_MAX_BYTES) {
      const base64 = arrayBufferToBase64(await blob.arrayBuffer());
      return `data:image/webp;base64,${base64}`;
    }
  }

  // Final fallback: shrink to 128px
  const small = new OffscreenCanvas(128, 128);
  const sctx = small.getContext("2d")!;
  const bmp2 = await createImageBitmap(file);
  const srcSize2 = Math.min(bmp2.width, bmp2.height);
  const sx2 = (bmp2.width - srcSize2) / 2;
  const sy2 = (bmp2.height - srcSize2) / 2;
  sctx.drawImage(bmp2, sx2, sy2, srcSize2, srcSize2, 0, 0, 128, 128);
  bmp2.close();
  const blob = await small.convertToBlob({ type: "image/webp", quality: 0.5 });
  const base64 = arrayBufferToBase64(await blob.arrayBuffer());
  return `data:image/webp;base64,${base64}`;
}
