import type { Action } from '@onlook/models/actions';
import { jsonClone } from '@onlook/utility';
import { makeAutoObservable } from 'mobx';
import type { EditorEngine } from '../engine';
import { transformRedoAction, undoAction, updateTransactionActions } from './helpers';

enum TransactionType {
    IN_TRANSACTION = 'in-transaction',
    NOT_IN_TRANSACTION = 'not-in-transaction',
}

interface InTransaction {
    type: TransactionType.IN_TRANSACTION;
    actions: Action[];
}

interface NotInTransaction {
    type: TransactionType.NOT_IN_TRANSACTION;
}

type TransactionState = InTransaction | NotInTransaction;

// A batch (e.g. multi-delete) tags every action it pushes with the same group id, so a single
// undo/redo reverses the whole batch instead of one element at a time. Untagged actions undo one
// at a time exactly as before.
type GroupedAction = Action & { __groupId?: number };

export class HistoryManager {
    private currentGroupId: number | null = null;
    private groupCounter = 0;

    constructor(
        private editorEngine: EditorEngine,
        private undoStack: GroupedAction[] = [],
        private redoStack: GroupedAction[] = [],
        private inTransaction: TransactionState = { type: TransactionType.NOT_IN_TRANSACTION },
    ) {
        makeAutoObservable(this);
    }

    /** Opens a batch: every action pushed until endGroup() shares one group id and undoes atomically. */
    startGroup = () => {
        this.currentGroupId = ++this.groupCounter;
    };

    endGroup = () => {
        this.currentGroupId = null;
    };

    get canUndo() {
        return this.undoStack.length > 0;
    }

    get canRedo() {
        return this.redoStack.length > 0;
    }

    get isInTransaction() {
        return this.inTransaction.type === TransactionType.IN_TRANSACTION;
    }

    get length() {
        return this.undoStack.length;
    }

    startTransaction = () => {
        this.inTransaction = { type: TransactionType.IN_TRANSACTION, actions: [] };
    };

    commitTransaction = async () => {
        if (
            this.inTransaction.type === TransactionType.NOT_IN_TRANSACTION ||
            this.inTransaction.actions.length === 0
        ) {
            this.inTransaction = { type: TransactionType.NOT_IN_TRANSACTION };
            return;
        }

        const actionsToCommit = this.inTransaction.actions;
        this.inTransaction = { type: TransactionType.NOT_IN_TRANSACTION };
        for (const action of actionsToCommit) {
            await this.push(action);
        }
    };

    push = async (action: Action) => {
        if (this.inTransaction.type === TransactionType.IN_TRANSACTION) {
            this.inTransaction.actions = updateTransactionActions(
                this.inTransaction.actions,
                action,
            );
            return;
        }

        if (this.redoStack.length > 0) {
            this.redoStack = [];
        }

        if (this.currentGroupId != null) {
            (action as GroupedAction).__groupId = this.currentGroupId;
        }
        this.undoStack.push(action);
        await this.editorEngine.code.write(action);

        switch (action.type) {
            case 'update-style':
                this.editorEngine.posthog.capture('style_action', {
                    style: jsonClone(
                        action.targets.length > 0 ? action.targets[0]?.change.updated : {},
                    ),
                });
                break;
            case 'insert-element':
                this.editorEngine.posthog.capture('insert_action');
                break;
            case 'move-element':
                this.editorEngine.posthog.capture('move_action');
                break;
            case 'remove-element':
                this.editorEngine.posthog.capture('remove_action');
                break;
            case 'edit-text':
                this.editorEngine.posthog.capture('edit_text_action');
        }
    };

    // Pops the top entry and, if it's part of a group, every consecutive entry sharing its group id.
    // Returns them newest-first (the order to undo). The popped originals are moved to redoStack.
    undo = (): Action[] => {
        if (this.inTransaction.type === TransactionType.IN_TRANSACTION) {
            this.commitTransaction();
        }

        const top = this.undoStack.pop();
        if (top == null) {
            return [];
        }
        const batch = this.popBatch(this.undoStack, top);
        for (const a of batch) {
            this.redoStack.push(a);
        }
        return batch.map((a) => undoAction(a));
    };

    redo = (): Action[] => {
        if (this.inTransaction.type === TransactionType.IN_TRANSACTION) {
            this.commitTransaction();
        }

        const top = this.redoStack.pop();
        if (top == null) {
            return [];
        }
        // undo() pushed the batch onto redoStack newest-first, so popping yields oldest-first here:
        // re-apply and re-stack in that chronological order to mirror the original sequence.
        const batch = this.popBatch(this.redoStack, top);
        for (const a of batch) {
            this.undoStack.push(a);
        }
        return batch.map((a) => transformRedoAction(a));
    };

    /** Given an already-popped top, pops the rest of its group off the stack. Returns [top, ...rest]. */
    private popBatch(stack: GroupedAction[], top: GroupedAction): GroupedAction[] {
        const batch = [top];
        const groupId = top.__groupId;
        if (groupId != null) {
            while (stack.length > 0 && stack[stack.length - 1].__groupId === groupId) {
                batch.push(stack.pop()!);
            }
        }
        return batch;
    }

    clear = () => {
        this.undoStack = [];
        this.redoStack = [];
    };
}
