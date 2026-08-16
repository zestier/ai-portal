import { describe, it, expect, beforeEach } from 'vitest';
import {
	imageLightbox,
	openImageLightbox,
	closeImageLightbox
} from '../../src/lib/client/image-lightbox.svelte';

describe('image-lightbox store', () => {
	beforeEach(() => closeImageLightbox());

	it('starts closed', () => {
		expect(imageLightbox.open).toBe(false);
	});

	it('opens with src and alt', () => {
		openImageLightbox('data:image/png;base64,AAA', 'a picture');
		expect(imageLightbox.open).toBe(true);
		expect(imageLightbox.src).toBe('data:image/png;base64,AAA');
		expect(imageLightbox.alt).toBe('a picture');
	});

	it('defaults alt to empty', () => {
		openImageLightbox('x.png');
		expect(imageLightbox.alt).toBe('');
	});

	it('ignores an empty src', () => {
		openImageLightbox('');
		expect(imageLightbox.open).toBe(false);
	});

	it('closes', () => {
		openImageLightbox('x.png', 'y');
		closeImageLightbox();
		expect(imageLightbox.open).toBe(false);
	});
});
