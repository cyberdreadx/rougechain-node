/**
 * Browser-side avatar processing: centered square crop + JPEG re-encode on a
 * canvas, stepping down size / quality until the data URI fits the node's
 * 256 KB avatar cap. Math lives in avatar.ts (unit-tested).
 */
import { AVATAR_ATTEMPTS, fitsAvatarLimit, squareCropRect } from "./avatar";

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read that image"));
    };
    img.src = url;
  });
}

/**
 * Turn a picked image file into a square JPEG data URI under the avatar cap.
 * Throws when the file is not an image or can't be made small enough.
 */
export async function fileToAvatarDataUri(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("Pick an image file");
  const img = await loadImage(file);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas not available");

  for (const attempt of AVATAR_ATTEMPTS) {
    const { sx, sy, side, out } = squareCropRect(img.naturalWidth, img.naturalHeight, attempt.edge);
    if (side <= 0) break;
    canvas.width = out;
    canvas.height = out;
    // JPEG has no alpha: paint a dark backdrop so transparent PNGs don't go black-on-black oddly.
    ctx.fillStyle = "#0b0b12";
    ctx.fillRect(0, 0, out, out);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, sx, sy, side, side, 0, 0, out, out);
    const dataUri = canvas.toDataURL("image/jpeg", attempt.quality);
    if (dataUri.startsWith("data:image/jpeg") && fitsAvatarLimit(dataUri)) return dataUri;
  }
  throw new Error("Image is too large even after compression");
}
