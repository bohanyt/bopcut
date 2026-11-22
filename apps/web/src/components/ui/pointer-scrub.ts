import type { PreviewGesture } from "@/core/managers/timeline-manager";

// Older browsers return void from requestPointerLock. Keep watching that request
// even if its scrub ends, and let subsequent scrubs use regular pointer events.
const pendingLocks = new WeakSet<Document>();

export function startPointerScrub({
	target,
	pointerId,
	onMove,
	onEnd,
	onCommit,
	onCancel,
	beginGesture,
}: {
	target: HTMLElement;
	pointerId: number;
	onMove: (delta: number) => void;
	onEnd?: () => void;
	onCommit: () => void;
	onCancel: () => void;
	beginGesture?: (cancel: () => void) => PreviewGesture;
}): () => void {
	const doc = target.ownerDocument;
	let active = true;
	let awaitingLock = false;
	let ownsLock = false;
	let firstMove = true;
	let hasValue = false;

	function releaseLock() {
		doc.removeEventListener("pointerlockchange", handleLockChange);
		if (ownsLock && doc.pointerLockElement === target) doc.exitPointerLock();
		ownsLock = false;
	}

	function settleLock() {
		if (!awaitingLock) return;
		awaitingLock = false;
		pendingLocks.delete(doc);
		doc.removeEventListener("pointerlockerror", settleLock);
		ownsLock = doc.pointerLockElement === target;
		if (!active || !ownsLock) releaseLock();
	}

	function handleLockChange() {
		if (awaitingLock) settleLock();
		else if (ownsLock && doc.pointerLockElement !== target) cancel();
	}

	function finish(shouldCommit: boolean) {
		if (!active) return;
		active = false;
		doc.removeEventListener("pointermove", handleMove);
		doc.removeEventListener("pointerup", handleUp);
		doc.removeEventListener("pointercancel", handlePointerCancel);
		target.removeEventListener("lostpointercapture", handlePointerCancel);
		doc.defaultView?.removeEventListener("blur", cancel);
		if (!awaitingLock) releaseLock();
		onEnd?.();
		if (shouldCommit) {
			gesture?.finish();
			if (hasValue) onCommit();
		} else {
			onCancel();
		}
	}

	function cancel() {
		if (gesture) gesture.cancel();
		else finish(false);
	}

	function handlePointerCancel(event: PointerEvent) {
		if (event.pointerId === pointerId) cancel();
	}

	function handleUp(event: PointerEvent) {
		if (event.pointerId === pointerId) finish(true);
	}

	function handleMove(event: PointerEvent) {
		if (event.pointerId !== pointerId) return;
		// The first move after requesting lock can contain a warp delta.
		if (firstMove) {
			firstMove = false;
			return;
		}
		if (event.movementX === 0) return;
		hasValue = true;
		onMove(event.movementX);
	}

	const gesture = beginGesture?.(() => finish(false));
	doc.addEventListener("pointermove", handleMove);
	doc.addEventListener("pointerup", handleUp);
	doc.addEventListener("pointercancel", handlePointerCancel);
	target.addEventListener("lostpointercapture", handlePointerCancel);
	doc.defaultView?.addEventListener("blur", cancel);
	if (target.requestPointerLock && !doc.pointerLockElement && !pendingLocks.has(doc)) {
		awaitingLock = true;
		pendingLocks.add(doc);
		doc.addEventListener("pointerlockchange", handleLockChange);
		doc.addEventListener("pointerlockerror", settleLock);
		try {
			void target.requestPointerLock()?.then(settleLock, settleLock);
		} catch {
			settleLock();
		}
	}
	return cancel;
}
