// lib/cloudinary.js
// Server-side image upload to Cloudinary — used for the custom chat-icon
// image feature. Uploading from the SERVER instead of straight from the
// browser means:
//   1. Only an authenticated, authorized agency/client user can trigger an
//      upload at all (the routes that call this are behind requireAuth).
//   2. File size/type checks happen before anything leaves our server.
//   3. The Cloudinary cloud name and preset never appear in browser
//      devtools/network tab — nothing for a random visitor to copy and
//      abuse to upload junk to your account.
//
// Uses Node 18+'s built-in fetch/FormData/Blob, so no extra HTTP client
// dependency is needed.

const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const UPLOAD_PRESET = process.env.CLOUDINARY_UPLOAD_PRESET;

const MAX_BYTES = 5 * 1024 * 1024; // 5MB

// Uploads a file buffer to Cloudinary and resolves with its secure URL.
// Throws a plain Error with a message safe to show the user.
async function uploadIconImage(buffer, mimeType) {
  if (!CLOUD_NAME || !UPLOAD_PRESET) {
    throw new Error('Cloudinary is not configured on the server — set CLOUDINARY_CLOUD_NAME and CLOUDINARY_UPLOAD_PRESET in .env');
  }
  if (!mimeType || !mimeType.startsWith('image/')) {
    throw new Error('Please upload an image file');
  }
  if (buffer.length > MAX_BYTES) {
    throw new Error('Image must be under 5MB');
  }

  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeType }));
  form.append('upload_preset', UPLOAD_PRESET);

  const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUD_NAME}/image/upload`, {
    method: 'POST',
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || 'Upload to Cloudinary failed');
  return data.secure_url;
}

module.exports = { uploadIconImage };
