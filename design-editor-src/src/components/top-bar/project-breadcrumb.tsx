// Local-only project breadcrumb. Onlook's version queried the cloud (api.project,
// api.subscription) and offered clone/recent-projects/download. Design is local, so this
// is just the CodeCanvas brand + a Settings entry that drives the local settings state.

import codecanvasLogo from '@/assets/codecanvas-logo.png';
import { useStateManager } from '@/components/store/state';
import { transKeys } from '@/i18n/keys';
import { Button } from '@onlook/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@onlook/ui/dropdown-menu';
import { Icons } from '@onlook/ui/icons';
import { cn } from '@onlook/ui/utils';
import { observer } from 'mobx-react-lite';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';

export const ProjectBreadcrumb = observer(() => {
    const stateManager = useStateManager();
    const t = useTranslations();
    const closeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [isDropdownOpen, setIsDropdownOpen] = useState(false);

    return (
        <div className="mr-0 flex flex-row items-center text-small gap-2">
            <DropdownMenu open={isDropdownOpen} onOpenChange={setIsDropdownOpen}>
                <DropdownMenuTrigger asChild>
                    <Button
                        variant='ghost'
                        className="ml-1 px-0 gap-2 text-foreground-onlook text-small hover:text-foreground-active hover:!bg-transparent cursor-pointer group"
                    >
                        <img
                            src={codecanvasLogo}
                            alt="CodeCanvas"
                            className={cn('w-7 h-7 hidden md:block object-contain')}
                        />
                        <span className="mx-0 max-w-[60px] md:max-w-[100px] lg:max-w-[200px] px-0 text-foreground-onlook text-small truncate cursor-pointer group-hover:text-foreground-active">
                            Design
                        </span>
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                    align="start"
                    className="w-56"
                    onMouseEnter={() => {
                        if (closeTimeoutRef.current) {
                            clearTimeout(closeTimeoutRef.current);
                        }
                    }}
                    onMouseLeave={() => {
                        closeTimeoutRef.current = setTimeout(() => {
                            setIsDropdownOpen(false);
                        }, 300);
                    }}
                >
                    <DropdownMenuItem
                        className="cursor-pointer"
                        onClick={() => (stateManager.isSettingsModalOpen = true)}
                    >
                        <div className="flex flex-row center items-center group">
                            <Icons.Gear className="mr-2 group-hover:rotate-12 transition-transform" />
                            {t(transKeys.help.menu.openSettings)}
                        </div>
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        </div>
    );
});
