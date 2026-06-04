/*---------------------------------------------------------------------------------------------
 *  CodeCanvas AI - Snapshots timeline view (bottom panel)
 *  Visual timeline matching the reference: dots, labels, restore/compare actions.
 *--------------------------------------------------------------------------------------------*/

import { $, append } from '../../../../base/browser/dom.js';
import { localize, localize2 } from '../../../../nls.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { ViewPane, IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';

export class CodeCanvasSnapshotsView extends ViewPane {
	static readonly ID = 'codecanvas.snapshots';
	static readonly NAME = localize2('snapshots', "Snapshots");

	private contentEl!: HTMLElement;

	constructor(
		options: IViewPaneOptions,
		@IThemeService themeService: IThemeService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IOpenerService openerService: IOpenerService,
		@IHoverService hoverService: IHoverService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService,
			viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.style.overflow = 'hidden';
		container.style.display = 'flex';
		container.style.flexDirection = 'column';

		this.contentEl = append(container, $('.cc-snapshots'));
		this.renderTimeline();
	}

	private renderTimeline(): void {
		this.contentEl.innerHTML = '';

		// Auto-saved indicator
		const header = append(this.contentEl, $('.cc-snapshots-header'));
		const autoSaved = append(header, $('.cc-snapshots-auto'));
		append(autoSaved, $('span.cc-snapshots-dot.cc-snapshots-dot-green'));
		append(autoSaved, $('span')).textContent = localize('snapshots.autoSaved', "Auto-saved");

		// Timeline track
		const track = append(this.contentEl, $('.cc-snapshots-track'));

		const snapshots = [
			{ time: '9:41 AM', label: localize('snapshots.initial', "Initial"), active: false },
			{ time: '9:57 AM', label: localize('snapshots.heroUpdate', "Hero update"), active: false },
			{ time: '10:12 AM', label: localize('snapshots.spacing', "Spacing tweaks"), active: false },
			{ time: '10:28 AM', label: localize('snapshots.aiContrast', "AI: Improve contrast"), active: true },
		];

		for (const snap of snapshots) {
			const node = append(track, $('.cc-snapshots-node'));
			const dot = append(node, $('.cc-snapshots-node-dot'));
			if (snap.active) {
				dot.classList.add('cc-snapshots-node-dot-active');
			}
			const info = append(node, $('.cc-snapshots-node-info'));
			append(info, $('span.cc-snapshots-time')).textContent = snap.time;
			append(info, $('span.cc-snapshots-label')).textContent = snap.label;
		}

		// Add button
		const addNode = append(track, $('.cc-snapshots-node.cc-snapshots-node-add'));
		append(addNode, $('span.codicon.codicon-add')).title = localize('snapshots.add', "Add snapshot");

		// Actions (Restore, Compare)
		const actions = append(this.contentEl, $('.cc-snapshots-actions'));
		const restoreBtn = append(actions, $('button.cc-snapshots-btn'));
		restoreBtn.innerHTML = `<span class="codicon codicon-discard"></span><span>${localize('snapshots.restore', "Restore")}</span>`;
		const compareBtn = append(actions, $('button.cc-snapshots-btn'));
		compareBtn.innerHTML = `<span class="codicon codicon-diff"></span><span>${localize('snapshots.compare', "Compare")}</span>`;
	}
}
