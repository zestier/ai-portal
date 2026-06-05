<div class="thinking" role="status" aria-live="polite">
	<span class="dot"></span><span class="dot"></span><span class="dot"></span>
	<span class="label muted">Thinking…</span>
</div>

<style>
	.thinking {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.4rem 0.1rem;
	}
	.dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--fg, currentColor);
		opacity: 0.35;
		animation: thinking-bounce 1.2s infinite ease-in-out;
	}
	.dot:nth-child(2) {
		animation-delay: 0.15s;
	}
	.dot:nth-child(3) {
		animation-delay: 0.3s;
	}
	.label {
		margin-left: 0.35rem;
		font-size: var(--fs-md);
	}
	@keyframes thinking-bounce {
		0%,
		80%,
		100% {
			transform: translateY(0);
			opacity: 0.35;
		}
		40% {
			transform: translateY(-3px);
			opacity: 0.9;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.dot {
			animation: none;
		}
	}
</style>
