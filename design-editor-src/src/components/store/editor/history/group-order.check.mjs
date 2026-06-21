// Runnable guard for the grouped undo/redo ordering in HistoryManager (index.ts). No test runner in
// this bundle, so this mirrors popBatch + the undo/redo stack moves 1:1 and asserts the invariants:
// a tagged batch undoes/redoes atomically and round-trips, while untagged ops stay one-at-a-time.
// Run: node group-order.check.mjs
import assert from 'node:assert';

// --- mirror of HistoryManager popBatch + undo/redo stack handling (ordering only) ---
function popBatch(stack, top) {
    const batch = [top];
    const groupId = top.__groupId;
    if (groupId != null) {
        while (stack.length > 0 && stack[stack.length - 1].__groupId === groupId) {
            batch.push(stack.pop());
        }
    }
    return batch;
}

function makeHistory() {
    const undoStack = [];
    const redoStack = [];
    return {
        undoStack, redoStack,
        push(a) { undoStack.push(a); redoStack.length = 0; },
        undo() {
            const top = undoStack.pop();
            if (top == null) return [];
            const batch = popBatch(undoStack, top);
            for (const a of batch) redoStack.push(a);
            return batch; // newest-first
        },
        redo() {
            const top = redoStack.pop();
            if (top == null) return [];
            const batch = popBatch(redoStack, top);
            for (const a of batch) undoStack.push(a);
            return batch; // chronological
        },
    };
}

const tag = (id, g) => ({ id, __groupId: g });

// 1) A 3-element batch undoes as ONE step, newest-first; redo restores chronological order.
{
    const h = makeHistory();
    h.push(tag('d1', 7)); h.push(tag('d2', 7)); h.push(tag('d3', 7));
    const undone = h.undo();
    assert.deepStrictEqual(undone.map(a => a.id), ['d3', 'd2', 'd1'], 'undo newest-first');
    assert.strictEqual(h.undoStack.length, 0, 'whole batch left undoStack');
    const redone = h.redo();
    assert.deepStrictEqual(redone.map(a => a.id), ['d1', 'd2', 'd3'], 'redo chronological');
    assert.deepStrictEqual(h.undoStack.map(a => a.id), ['d1', 'd2', 'd3'], 'stack restored to original');
}

// 2) Untagged ops stay one-at-a-time (no regression for single delete / style / move).
{
    const h = makeHistory();
    h.push(tag('a')); h.push(tag('b'));
    assert.deepStrictEqual(h.undo().map(a => a.id), ['b'], 'single pop');
    assert.deepStrictEqual(h.undo().map(a => a.id), ['a'], 'single pop');
    assert.deepStrictEqual(h.undo(), [], 'empty');
}

// 3) A single op after a batch: the single undoes alone, then the batch atomically.
{
    const h = makeHistory();
    h.push(tag('d1', 1)); h.push(tag('d2', 1)); // batch
    h.push(tag('s'));                            // later single
    assert.deepStrictEqual(h.undo().map(a => a.id), ['s'], 'single first');
    assert.deepStrictEqual(h.undo().map(a => a.id), ['d2', 'd1'], 'then whole batch');
}

// 4) Two separate batches don't merge (different group ids).
{
    const h = makeHistory();
    h.push(tag('a1', 1)); h.push(tag('a2', 1));
    h.push(tag('b1', 2)); h.push(tag('b2', 2));
    assert.deepStrictEqual(h.undo().map(a => a.id), ['b2', 'b1'], 'second batch only');
    assert.deepStrictEqual(h.undo().map(a => a.id), ['a2', 'a1'], 'first batch only');
}

console.log('group-order.check: all invariants pass');
