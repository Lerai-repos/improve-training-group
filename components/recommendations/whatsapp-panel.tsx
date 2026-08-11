'use client';

import { useCallback, useRef, useState } from 'react';
import { AlertTriangle, ChevronDown, Copy, Loader2, MessageSquare } from 'lucide-react';

import { Button } from '@components/ui/button';
import { cn } from '@lib/utils';

import type { WhatsappMessage } from './use-whatsapp-message';

/**
 * The copyable, editable "Ben jij beschikbaar?" message for one training.
 *
 * Rendering is dumb on purpose: every rule about saving, staleness and reconciliation
 * lives in `use-whatsapp-message.ts`, where it can be tested without a DOM.
 */

interface WhatsappPanelProps {
  message: WhatsappMessage;
  onClose: () => void;
}

type CopyState = 'idle' | 'copied' | 'manual';

export const WhatsappPanel = ({ message, onClose }: WhatsappPanelProps) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [copied, setCopied] = useState<CopyState>('idle');

  /**
   * Three ways to copy, because only the first is pleasant and none is guaranteed.
   *
   * `navigator.clipboard.writeText` needs the host to grant `clipboard-write` on the
   * iframe, and Monday controls that. When it is refused we fall back to selecting the
   * text and asking the browser to copy the selection; if that fails too the text is at
   * least already selected, so Ctrl/⌘-C works.
   */
  const handleCopy = useCallback(async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(message.text);
      setCopied('copied');
      return;
    } catch {
      // fall through
    }
    const node = textareaRef.current;
    node?.select();
    try {
      setCopied(document.execCommand('copy') ? 'copied' : 'manual');
    } catch {
      setCopied('manual');
    }
  }, [message.text]);

  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>): void => {
      setCopied('idle');
      message.setText(event.target.value);
    },
    [message]
  );

  /**
   * Closing waits on the save, and **a failed save cancels the close**.
   *
   * Closing anyway would unmount the error and take the draft with it — the one place
   * where the error handling and the dismissal handling contradict each other.
   */
  const handleClose = useCallback((): void => {
    void message.flush().then((saved) => {
      if (saved) {
        onClose();
      }
    });
  }, [message, onClose]);

  /**
   * Escape is a deliberate close, so it takes the same route as Sluiten — flush first,
   * and stay open if that fails. A key that discarded an unsaved draft where the button
   * does not would be a trap.
   */
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        handleClose();
      }
    },
    [handleClose]
  );

  const handleDiscard = useCallback((): void => {
    void message.discard();
  }, [message]);

  const handleRetry = useCallback((): void => {
    void message.retry();
  }, [message]);

  const handleReload = useCallback((): void => {
    void message.reload();
  }, [message]);

  return (
    <div
      role="dialog"
      aria-label="WhatsApp-bericht"
      onKeyDown={handleKeyDown}
      className="absolute right-0 top-10 z-20 w-[26rem] rounded-md border border-border bg-card p-3 shadow-lg"
    >
      {message.loading && (
        <p className="text-sm text-muted-foreground">
          <Loader2 className="mr-2 inline size-4 animate-spin" />
          Bericht wordt opgehaald…
        </p>
      )}

      {message.loadError !== null && (
        <Notice tone="error">Het bericht kon niet worden opgehaald. ({message.loadError})</Notice>
      )}

      {!message.loading && message.loadError === null && (
        <>
          {message.stale && (
            <Notice tone="warning">
              De trainingsgegevens zijn gewijzigd sinds dit bericht is opgeslagen.
            </Notice>
          )}

          {message.unreadable && (
            <Notice tone="warning">
              Er staat een opgeslagen bewerking die niet gelezen kon worden. Met “Herstel
              origineel” ruim je die op.
            </Notice>
          )}

          {message.warnings.map((warning) => (
            <Notice key={warning}>{warning}</Notice>
          ))}

          <label className="sr-only" htmlFor="whatsapp-text">
            Berichttekst
          </label>
          <textarea
            id="whatsapp-text"
            ref={textareaRef}
            value={message.text}
            onChange={handleChange}
            rows={12}
            spellCheck={false}
            className="w-full resize-y rounded border bg-background p-2 font-mono text-xs leading-relaxed"
          />
          <p className="mt-1 text-[11px] text-muted-foreground">
            Wijzigingen worden bewaard. Zet er geen telefoonnummers of persoonsgegevens in.
          </p>

          <SaveStatus message={message} onRetry={handleRetry} onReload={handleReload} />

          <div className="mt-3 flex items-center justify-between gap-2">
            <Button size="sm" onClick={handleCopy}>
              <Copy className="mr-2 size-3" />
              Kopieer
            </Button>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={handleDiscard}>
                Herstel origineel
              </Button>
              <Button variant="outline" size="sm" onClick={handleClose}>
                Sluiten
              </Button>
            </div>
          </div>

          {copied === 'copied' && (
            <p className="mt-2 text-xs text-muted-foreground">Gekopieerd.</p>
          )}
          {copied === 'manual' && (
            <p className="mt-2 text-xs text-muted-foreground">
              Kopiëren mocht niet van de browser — de tekst staat geselecteerd, druk Ctrl/⌘-C.
            </p>
          )}
        </>
      )}
    </div>
  );
};

const SaveStatus = ({
  message,
  onRetry,
  onReload,
}: {
  message: WhatsappMessage;
  onRetry: () => void;
  onReload: () => void;
}) => {
  const { save } = message;
  if (save.kind === 'saving') {
    return <p className="mt-1 text-xs text-muted-foreground">Opslaan…</p>;
  }
  if (save.kind === 'saved') {
    return <p className="mt-1 text-xs text-muted-foreground">Opgeslagen.</p>;
  }
  if (save.kind === 'conflict') {
    return (
      <Notice tone="warning">
        Een collega heeft dit bericht gewijzigd. Jouw tekst staat er nog — herlaad om die van
        hen te zien.{' '}
        <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={onReload}>
          Herladen
        </Button>
      </Notice>
    );
  }
  if (save.kind === 'error') {
    return (
      <Notice tone="error">
        Niet opgeslagen. ({save.message}){' '}
        <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={onRetry}>
          Opnieuw proberen
        </Button>
      </Notice>
    );
  }
  return null;
};

const Notice = ({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'warning' | 'error';
  children: React.ReactNode;
}) => (
  <p
    className={cn(
      'mb-2 flex items-start gap-2 rounded border p-2 text-xs',
      tone === 'error' && 'border-destructive/40 text-destructive',
      tone === 'warning' && 'border-amber-500/40'
    )}
  >
    {tone !== 'info' && <AlertTriangle className="mt-0.5 size-3 shrink-0" />}
    <span>{children}</span>
  </p>
);

export const WhatsappButton = ({
  open,
  onToggle,
  buttonRef,
}: {
  open: boolean;
  onToggle: () => void;
  buttonRef?: React.RefObject<HTMLButtonElement | null>;
}) => (
  <Button ref={buttonRef} variant="outline" size="sm" onClick={onToggle} aria-expanded={open}>
    <MessageSquare className="mr-2 size-3" />
    WhatsApp-bericht
    <ChevronDown className={cn('ml-1 size-3 transition-transform', open && 'rotate-180')} />
  </Button>
);
