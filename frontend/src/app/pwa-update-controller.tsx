import type {PropsWithChildren} from 'react';

import type {PwaUpdateBootstrap} from '@/platform/pwa/update-bootstrap';
import type {PwaUpdateSnapshot} from '@/platform/pwa/update-lifecycle';

// Updates are picked up on the next visit or reload, without interrupting input.
export function PwaUpdateNotice(_props: {
    actionError: boolean;
    activating: boolean;
    onActivate: () => void;
    onRetry: () => void;
    snapshot: PwaUpdateSnapshot;
}) {
    return null;
}

export function PwaUpdateController({children}: PropsWithChildren<{
    bootstrap: PwaUpdateBootstrap | null;
}>) {
    return <>{children}</>;
}
