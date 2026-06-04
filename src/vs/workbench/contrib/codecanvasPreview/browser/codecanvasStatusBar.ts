/*---------------------------------------------------------------------------------------------
 *  CodeCanvas AI - Status bar items
 *  Adds the "AI: Ready" indicator on the right of the status bar, matching the reference.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';

const AI_STATUS_ID = 'status.codecanvasAI';

export class CodeCanvasStatusBarContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.codecanvasStatusBar';

	constructor(
		@IStatusbarService statusbarService: IStatusbarService,
	) {
		super();
		this._register(statusbarService.addEntry(
			{
				name: localize('cc.aiStatus.name', "CodeCanvas AI"),
				text: `$(sparkle) ${localize('cc.aiStatus.ready', "AI: Ready")}`,
				ariaLabel: localize('cc.aiStatus.ready', "AI: Ready"),
				tooltip: localize('cc.aiStatus.tooltip', "CodeCanvas AI is ready"),
			},
			AI_STATUS_ID,
			StatusbarAlignment.RIGHT,
			50 // left of the editor position indicators (Ln/Col, encoding, language)
		));
	}
}
