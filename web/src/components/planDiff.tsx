import type { ReactNode } from 'react';
import type { ProposedAction } from '../api/types.ts';

// The approval diff (spec §13.5).
//
// One question, answered per action: **what is true now, and what will be true
// if I approve this?** A reviewer deciding in ten seconds needs the change, not
// a payload dump — so each row states the before and the after in the CRM's own
// language.
//
// Read-only *here*. Editing happens in its own form ("Edit proposal"), which
// renders a typed control per editable field rather than turning this table
// into an input grid — a diff answers "what will change?", and mixing that
// question with "what would you like it to say?" makes it answer neither well.

const ACTION_LABELS: Record<string, string> = {
  create_company: 'Create company',
  create_contact: 'Create contact',
  link_contact_to_company: 'Link contact',
  log_activity: 'Log activity',
  add_note: 'Add note',
  create_deal: 'Create deal',
  update_deal_stage: 'Move deal stage',
  update_deal_amount: 'Change deal value',
  create_task: 'Create task',
  archive_email: 'Archive email',
  send_email: 'Queue reply',
};

type Change = { before: string; after: string };

/** What this action changes, in the CRM's own terms. */
function describe(action: ProposedAction): Change {
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  const text = (value: unknown): string => (typeof value === 'string' && value !== '' ? value : '');

  switch (action.type) {
    case 'create_company':
      return {
        before: 'no such company in the CRM',
        after: `${text(payload.name)}${payload.domain ? ` (${text(payload.domain)})` : ''}`,
      };
    case 'create_contact':
      return {
        before: 'no such contact in the CRM',
        after: `${text(payload.fullName)} · ${text(payload.email)}`,
      };
    case 'link_contact_to_company':
      return { before: 'contact not attached to a company', after: 'attached to the matched company' };
    case 'create_deal': {
      const parts = [
        `"${text(payload.title)}"`,
        `stage: ${text(payload.stage).replace(/_/g, ' ')}`,
        payload.budgetNote ? `budget noted: ${text(payload.budgetNote)}` : 'amount: not set',
      ];
      return { before: 'no deal in the pipeline', after: parts.join(' · ') };
    }
    case 'update_deal_stage':
      return {
        before: `stage: ${text(payload.fromStage).replace(/_/g, ' ')}`,
        after: `stage: ${text(payload.toStage).replace(/_/g, ' ')}`,
      };
    case 'update_deal_amount':
      return { before: 'current deal value', after: `value: ${String(payload.amountMinor ?? '')}` };
    case 'create_task':
      return {
        before: 'no follow-up scheduled',
        after: `"${text(payload.title)}"${payload.dueAt ? ` due ${new Date(text(payload.dueAt)).toLocaleString()}` : ''}`,
      };
    case 'log_activity':
      return { before: 'not on the timeline', after: `timeline entry: "${text(payload.subject)}"` };
    case 'add_note':
      return { before: 'no note', after: text(payload.body).slice(0, 90) };
    case 'archive_email':
      return { before: 'in the inbox', after: 'archived, with no CRM record' };
    case 'send_email':
      return { before: 'no reply queued', after: `queued to ${text(payload.toEmail)} — held, not sent` };
    default:
      return { before: '—', after: '—' };
  }
}

export function PlanDiff({ actions }: { actions: ProposedAction[] }): ReactNode {
  if (actions.length === 0) {
    return <p className="text-small text-ink-muted">This plan contains no actions.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] border-collapse text-left">
        <thead>
          <tr className="border-b border-line text-meta uppercase tracking-wide text-ink-muted">
            <th className="py-2 pr-3 font-semibold">Action</th>
            <th className="py-2 pr-3 font-semibold">Now</th>
            <th className="py-2 font-semibold">If approved</th>
          </tr>
        </thead>
        <tbody>
          {actions.map((action, index) => {
            const change = describe(action);
            return (
              <tr key={`${action.type}-${index}`} className="border-b border-line last:border-0 align-top">
                <td className="py-2 pr-3 text-small font-semibold text-ink">
                  {ACTION_LABELS[action.type] ?? action.type}
                </td>
                <td className="py-2 pr-3 text-meta text-ink-muted">{change.before}</td>
                <td className="py-2 text-meta text-ink">{change.after}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-2 text-meta text-ink-muted">
        Nothing here has happened yet. Use “Edit proposal” to change the wording before approving.
      </p>
    </div>
  );
}
