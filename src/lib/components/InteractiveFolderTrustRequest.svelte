<script lang="ts">
	import type { InteractiveFolderTrustView, InteractiveResponse } from '$lib/types';

	let {
		request,
		busy,
		onRespond
	}: {
		request: InteractiveFolderTrustView & { requestId: string };
		busy: boolean;
		onRespond: (r: InteractiveResponse) => void;
	} = $props();
</script>

<div class="head">Trust this workspace folder?</div>
<div class="body">
	<p>
		Copilot is about to run in a folder that hasn't been trusted yet. Trusting it loads tools and
		MCP servers configured in the workspace (for example a <code>.mcp.json</code>). Only trust
		folders whose contents you recognize.
	</p>
	<pre>{request.path}</pre>
</div>
<div class="actions">
	<button
		class="btn"
		disabled={busy}
		onclick={() => onRespond({ kind: 'folder_trust', trust: false })}>Don't trust</button
	>
	<button
		class="btn primary"
		disabled={busy}
		onclick={() => onRespond({ kind: 'folder_trust', trust: true })}>Trust folder</button
	>
</div>
