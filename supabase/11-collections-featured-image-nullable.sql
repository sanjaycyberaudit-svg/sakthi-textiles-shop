-- Allow categories without a dedicated image; Velo can fall back to a product photo.
ALTER TABLE collections
  ALTER COLUMN featured_image_id DROP NOT NULL;
