import { createWriteStream } from 'fs';
import { mkdir } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { pipeline } from 'stream/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const IMAGES_DIR = join(__dirname, '..', 'uploads', 'profile-images');

/**
 * Download an image from a URL and save it locally
 * @param {string} url - The URL of the image to download
 * @param {string} filename - The filename to save the image as (without path)
 * @returns {Promise<string>} - The relative path to the saved image
 */
export async function downloadProfileImage(url, filename) {
  if (!url) {
    return null;
  }

  try {
    // Ensure the uploads directory exists
    await mkdir(IMAGES_DIR, { recursive: true });

    const response = await fetch(url);
    if (!response.ok) {
      console.warn(`[imageDownload] Failed to fetch ${url}: ${response.status}`);
      return null;
    }

    const filePath = join(IMAGES_DIR, filename);
    const fileStream = createWriteStream(filePath);

    // Use pipeline to handle the stream properly
    await pipeline(response.body, fileStream);

    // Return the path relative to the server directory for serving
    return `/uploads/profile-images/${filename}`;
  } catch (err) {
    console.error(`[imageDownload] Error downloading ${url}:`, err.message);
    return null;
  }
}

/**
 * Generate a safe filename for a student's profile image
 * @param {string} schoologyUid - The student's Schoology UID
 * @param {string} url - The original image URL (to extract extension)
 * @returns {string} - A safe filename
 */
export function generateImageFilename(schoologyUid, url) {
  // Extract extension from URL if possible, default to jpg
  let ext = 'jpg';
  if (url) {
    const match = url.match(/\.(jpg|jpeg|png|gif|webp)(\?|$)/i);
    if (match) {
      ext = match[1].toLowerCase();
    }
  }
  return `${schoologyUid}.${ext}`;
}
