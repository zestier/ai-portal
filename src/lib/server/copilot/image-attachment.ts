// Image capture for the `view`-tool attachment feature.
//
// The native SDK `view` tool's completion event carries no image bytes, so the
// portal captures them itself. The detection/read primitives are generic and
// shared with the file browser; they live in `server/image-detect.ts`. This
// module just re-exports them under the names the attachment code/tests use.

export {
	MAX_IMAGE_ATTACHMENT_BYTES,
	MAX_IMAGE_PREVIEW_BYTES,
	isAllowlistedImageExtension,
	sniffImageMime,
	detectImageMime,
	readImageFile as captureImageAttachment,
	type CapturedImage
} from '../image-detect';
