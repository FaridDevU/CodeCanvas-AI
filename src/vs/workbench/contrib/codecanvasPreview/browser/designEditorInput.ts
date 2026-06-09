/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { URI } from '../../../../base/common/uri.js';
import { IUntypedEditorInput } from '../../../common/editor.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';

export const designEditorInputTypeId = 'workbench.editors.designEditor';

export interface DesignEditorOptions extends IEditorOptions {
}

export class DesignEditorInput extends EditorInput {

	static readonly ID = designEditorInputTypeId;
	static readonly RESOURCE = URI.from({ scheme: 'codecanvas-design', authority: 'design_page' });

	override get typeId(): string {
		return DesignEditorInput.ID;
	}

	override get editorId(): string | undefined {
		return this.typeId;
	}

	override toUntyped(): IUntypedEditorInput {
		return {
			resource: DesignEditorInput.RESOURCE,
			options: {
				override: DesignEditorInput.ID,
				pinned: false
			}
		};
	}

	get resource(): URI | undefined {
		return DesignEditorInput.RESOURCE;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(other)) {
			return true;
		}
		return other instanceof DesignEditorInput;
	}

	constructor() {
		super();
	}

	override getName() {
		return localize('design', "Design");
	}
}
