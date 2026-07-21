// Keeping the receipt itself, not just the numbers we read off it.
//
// Until this existed the photo was read by the vision model and discarded, and
// raw_media_url held a Twilio link — which needs our Twilio credentials to open
// and which Twilio eventually deletes. So a disputed entry had no evidence
// behind it, in a product whose whole job is keeping records.
//
// PRIVACY: receipts are other businesses' financial documents — vendor, amounts,
// sometimes a KRA PIN. They are uploaded as `type: 'authenticated'`, so the
// stored URL is not publicly fetchable and reading one needs a signed URL we
// generate on demand (see signedUrlFor). Cloudinary's default is public
// delivery; that would put customer receipts on a guessable public URL.
//
// The signed URL does not expire — see signedUrlFor for why, and for what
// carries the protection instead.
//
// RESIDENCY: which region holds the images is an open legal question (Kenya's
// Data Protection Act constrains moving personal data abroad). It is deliberately
// not hardcoded — CLOUDINARY_FOLDER and the account's own region carry it, so
// answering the question later is configuration, not a migration.

const cloudinary = require('cloudinary').v2;

const FOLDER = process.env.CLOUDINARY_FOLDER || 'weza-ai/receipts';

let configured = false;

function isImageStoreConfigured() {
  return Boolean(
    process.env.CLOUDINARY_CLOUD_NAME
    && process.env.CLOUDINARY_API_KEY
    && process.env.CLOUDINARY_API_SECRET,
  );
}

// Configured lazily so requiring this module never throws on a machine without
// Cloudinary credentials — the rest of the pipeline still works without it.
function getClient() {
  if (!configured) {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
      secure: true,
    });
    configured = true;
  }
  return cloudinary;
}

/**
 * Store one receipt image. Returns { url, publicId } or null.
 *
 * NEVER throws. A storage failure must not cost the owner their transaction:
 * the numbers are already extracted by this point, and losing the row because a
 * third party was slow would be a far worse outcome than losing the picture.
 * Callers treat null as "no image kept" and carry on.
 *
 * Images are foldered per business so that everything belonging to one owner can
 * be found — and deleted — in one place, which is what a data deletion request
 * will need.
 */
async function storeReceiptImage(buffer, { businessId, messageSid }) {
  if (!isImageStoreConfigured()) {
    console.warn('[images] Cloudinary not configured — receipt image not kept.');
    return null;
  }
  if (!buffer || buffer.length === 0) return null;

  try {
    const started = Date.now();
    const result = await new Promise((resolve, reject) => {
      const stream = getClient().uploader.upload_stream(
        {
          folder: `${FOLDER}/${businessId}`,
          // Ties the stored image to the message it came from, and makes the
          // upload idempotent: a redelivered webhook overwrites rather than
          // leaving a second copy we would then be paying to keep.
          public_id: messageSid || undefined,
          overwrite: true,
          resource_type: 'image',
          type: 'authenticated',
        },
        (err, res) => (err ? reject(err) : resolve(res)),
      );
      stream.end(buffer);
    });

    console.log('[images] stored receipt', {
      publicId: result.public_id,
      bytes: result.bytes,
      elapsedMs: Date.now() - started,
    });
    return { url: result.secure_url, publicId: result.public_id };
  } catch (err) {
    console.error('[images] upload failed — transaction kept, image not:', err.message);
    return null;
  }
}

/**
 * A signed link to a stored receipt. Authenticated images can't be fetched from
 * their bare URL, so this is how one is ever looked at again.
 *
 * NOT time-limited, despite the obvious way to write it. `expires_at` is
 * silently ignored by cloudinary.url() for signed delivery URLs — the output is
 * byte-identical with an expiry, without one, and with a far-future one, which
 * was verified rather than assumed. Real expiry needs Cloudinary's token-based
 * authentication, which is an account-level feature we don't have. Claiming a
 * TTL here would be a security property we don't actually provide.
 *
 * What protects the image is that the URL cannot be constructed without the API
 * secret, and that we never hand it to the owner: 'receipt' sends the photo
 * itself, so Twilio fetches this URL server-side and re-hosts the image. The
 * signed link goes from us to Twilio and no further.
 */
function signedUrlFor(publicId) {
  if (!publicId || !isImageStoreConfigured()) return null;
  return getClient().url(publicId, {
    type: 'authenticated',
    resource_type: 'image',
    secure: true,
    sign_url: true,
  });
}

/**
 * Remove every stored image for one business. Not wired to a command yet — it
 * exists because a data deletion request is a legal obligation, not a feature,
 * and discovering there was no way to honour one would be the wrong moment.
 */
async function deleteBusinessImages(businessId) {
  if (!isImageStoreConfigured()) return { deleted: 0 };
  const prefix = `${FOLDER}/${businessId}`;
  const res = await getClient().api.delete_resources_by_prefix(prefix, {
    type: 'authenticated',
    resource_type: 'image',
  });
  const deleted = Object.keys(res.deleted || {}).length;
  console.log('[images] deleted stored receipts', { businessId, prefix, deleted });
  return { deleted };
}

module.exports = {
  isImageStoreConfigured,
  storeReceiptImage,
  signedUrlFor,
  deleteBusinessImages,
  FOLDER,
};
