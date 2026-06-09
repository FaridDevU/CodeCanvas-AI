export class EditorState {
  static create() { return new EditorState(); }
  doc = { textContent: '' };
  selection = { empty: true };
  tr = { insertText: () => this, setMeta: () => this };
}

export class Selection {
  static near() { return new Selection(); }
  empty = true;
}

export class TextSelection extends Selection {}
