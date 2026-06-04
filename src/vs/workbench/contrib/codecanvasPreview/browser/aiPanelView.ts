/*---------------------------------------------------------------------------------------------
 *  CodeCanvas AI - AI Panel view (right sidebar)
 *  Visual layout matching the reference: chat, proposed changes, accept/reject.
 *--------------------------------------------------------------------------------------------*/

import './media/aiPanelView.css';
import { $, append } from '../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
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

export class CodeCanvasAiPanelView extends ViewPane {
	static readonly ID = 'codecanvas.aiPanel';
	static readonly NAME = localize2('aiPanel', "CodeCanvas AI");

	private contentEl!: HTMLElement;
	private readonly disposables = new DisposableStore();

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

		this.contentEl = append(container, $('.cc-ai-panel'));
		this.renderStructure();
	}

	private renderStructure(): void {
		this.contentEl.innerHTML = '';

		// Chat messages area
		const messages = append(this.contentEl, $('.cc-ai-messages'));

		// AI greeting
		const greeting = append(messages, $('.cc-ai-message.cc-ai-from-ai'));
		append(greeting, $('.cc-ai-avatar')).textContent = '*';
		const greetingText = append(greeting, $('.cc-ai-text'));
		greetingText.textContent = localize('aiPanel.greeting', "Hi! I can see you're working on your project. What would you like to enhance?");

		// User message placeholder
		const userMsg = append(messages, $('.cc-ai-message.cc-ai-from-user'));
		append(userMsg, $('.cc-ai-text')).textContent = localize('aiPanel.userPlaceholder', "Make the hero section more premium with better contrast and spacing.");

		// AI response
		const aiResponse = append(messages, $('.cc-ai-message.cc-ai-from-ai'));
		append(aiResponse, $('.cc-ai-avatar')).textContent = '*';
		append(aiResponse, $('.cc-ai-text')).textContent = localize('aiPanel.response', "I'll enhance your hero section to feel more premium by improving contrast, typography, spacing, and visual hierarchy.");

		// Proposed changes section
		const proposed = append(this.contentEl, $('.cc-ai-proposed'));
		const proposedHeader = append(proposed, $('.cc-ai-proposed-header'));
		append(proposedHeader, $('span')).textContent = localize('aiPanel.proposedChanges', "Proposed changes");
		const proposedTabs = append(proposedHeader, $('.cc-ai-proposed-tabs'));
		append(proposedTabs, $('span.cc-ai-tab.active')).textContent = localize('aiPanel.preview', "Preview");
		append(proposedTabs, $('span.cc-ai-tab')).textContent = localize('aiPanel.diff', "Diff");

		// Preview thumbnail placeholder
		append(proposed, $('.cc-ai-preview-thumb')).textContent = localize('aiPanel.previewPlaceholder', "Preview");

		// What I changed list
		const changed = append(this.contentEl, $('.cc-ai-changed'));
		append(changed, $('.cc-ai-changed-title')).textContent = localize('aiPanel.whatChanged', "What I changed:");
		const changedList = append(changed, $('ul.cc-ai-changed-list'));
		const changes = [
			localize('aiPanel.change1', "Increased headline contrast"),
			localize('aiPanel.change2', "Enhanced gradient and glow"),
			localize('aiPanel.change3', "Improved spacing and hierarchy"),
			localize('aiPanel.change4', "Upgraded CTAs for more impact"),
		];
		for (const c of changes) {
			const li = append(changedList, $('li'));
			append(li, $('span.cc-ai-check')).textContent = '\u2713';
			append(li, $('span')).textContent = c;
		}

		// Accept / Reject buttons
		const actions = append(this.contentEl, $('.cc-ai-actions'));
		const acceptBtn = append(actions, $('button.cc-ai-btn.cc-ai-btn-primary'));
		acceptBtn.textContent = localize('aiPanel.accept', "Accept");
		const rejectBtn = append(actions, $('button.cc-ai-btn.cc-ai-btn-secondary'));
		rejectBtn.textContent = localize('aiPanel.reject', "Reject");

		// Apply to dropdown placeholder
		const applyRow = append(this.contentEl, $('.cc-ai-apply-row'));
		append(applyRow, $('span')).textContent = localize('aiPanel.applyTo', "Apply to");
		const applyDropdown = append(applyRow, $('span.cc-ai-dropdown'));
		applyDropdown.innerHTML = `<span class="codicon codicon-file-code"></span><span>hero.tsx</span><span class="codicon codicon-chevron-down"></span>`;

		// Input area at bottom
		const inputArea = append(this.contentEl, $('.cc-ai-input-area'));
		const inputBox = append(inputArea, $('input.cc-ai-input')) as HTMLInputElement;
		inputBox.placeholder = localize('aiPanel.askPlaceholder', "Ask CodeCanvas AI...");
		const inputActions = append(inputArea, $('.cc-ai-input-actions'));
		append(inputActions, $('span.codicon.codicon-add')).title = localize('aiPanel.addContext', "Add context");
		append(inputActions, $('span.codicon.codicon-send')).title = localize('aiPanel.send', "Send");

		// Footer disclaimer
		append(this.contentEl, $('.cc-ai-footer')).textContent = localize('aiPanel.disclaimer', "AI suggestions may be inaccurate");
	}

	override dispose(): void {
		this.disposables.dispose();
		super.dispose();
	}
}
