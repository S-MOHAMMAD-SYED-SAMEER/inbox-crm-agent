import { useState, type ReactNode } from 'react';
import { api } from '../api/client.ts';
import { FilterChip, RecordTable, SourceBadge } from '../components/recordTable.tsx';
import {
  actorLabel,
  eventLabel,
  formatAmount,
  formatDate,
  isOverdue,
  outcomeLabel,
  stageLabel,
  taskStatusLabel,
} from '../crm/presentation.ts';
import type { AuditRow, CompanyRow, ContactRow, DealRow, TaskRow } from '../api/types.ts';

// The CRM screens (M6-C).
//
// These close the loop the demo left open. The assistant has been creating
// companies, contacts, deals and tasks since M4-A, and the only place any of it
// was visible was the execution list on the email that made it — so a client had
// to take the app's word for it. Now they can look.
//
// EVERY ROW IS SERVER TRUTH. There is no fixture, no placeholder row and no
// derived value that the server did not send. Relationship names are resolved in
// the query; these components render what arrives.
//
// All five are read-only, because the CRM is. The only thing that writes to it
// is the executor, after an approval.

const CELL = 'px-4 py-3 text-small';

// ------------------------------------------------------------------- deals

const DEAL_STAGES = ['new_lead', 'qualifying', 'proposal', 'negotiation', 'won', 'lost'] as const;

export function Deals(): ReactNode {
  const [stage, setStage] = useState<string | null>(null);

  return (
    <RecordTable<DealRow>
      noun="deals"
      emptyHint="Deals appear here when the assistant opens one from an email and a person approves it."
      reloadKey={stage ?? 'all'}
      load={async () => {
        const { deals, total } = await api.listDeals(stage ?? undefined);
        return { rows: deals, total };
      }}
      keyOf={(deal) => deal.id}
      columns={['Deal', 'Company', 'Contact', 'Stage', 'Value', 'Source']}
      toolbar={
        <>
          <FilterChip label="All stages" active={stage === null} onClick={() => setStage(null)} />
          {DEAL_STAGES.map((value) => (
            <FilterChip key={value} label={stageLabel(value)} active={stage === value} onClick={() => setStage(value)} />
          ))}
        </>
      }
      renderRow={(deal) => (
        <>
          <td className={`${CELL} font-semibold text-ink`}>
            {deal.title}
            {deal.requirementSummary ? (
              <p className="mt-0.5 text-meta font-normal text-ink-muted">{deal.requirementSummary}</p>
            ) : null}
          </td>
          <td className={`${CELL} text-ink-muted`}>{deal.companyName ?? '—'}</td>
          <td className={`${CELL} text-ink-muted`}>
            {deal.contactName ?? '—'}
            {deal.contactEmail ? <p className="text-meta">{deal.contactEmail}</p> : null}
          </td>
          <td className={CELL}>
            <span className="whitespace-nowrap rounded-pill border border-line-strong px-2 py-0.5 text-meta text-ink-muted">
              {stageLabel(deal.stage)}
            </span>
          </td>
          <td className={`${CELL} text-ink-muted`}>
            {formatAmount(deal.amountMinor, deal.currency)}
            {deal.budgetNote ? <p className="text-meta">“{deal.budgetNote}”</p> : null}
          </td>
          <td className={CELL}>
            <SourceBadge source={deal.source} />
          </td>
        </>
      )}
    />
  );
}

// ---------------------------------------------------------------- contacts

export function Contacts(): ReactNode {
  return (
    <RecordTable<ContactRow>
      noun="contacts"
      emptyHint="Contacts appear here when the assistant identifies a sender and a person approves the plan."
      load={async () => {
        const { contacts, total } = await api.listContacts();
        return { rows: contacts, total };
      }}
      keyOf={(contact) => contact.id}
      columns={['Name', 'Email', 'Company', 'Role', 'Activity', 'Source']}
      renderRow={(contact) => (
        <>
          <td className={`${CELL} font-semibold text-ink`}>{contact.fullName}</td>
          <td className={`${CELL} break-all text-ink-muted`}>{contact.email}</td>
          <td className={`${CELL} text-ink-muted`}>{contact.companyName ?? '—'}</td>
          <td className={`${CELL} text-ink-muted`}>{contact.jobTitle ?? '—'}</td>
          <td className={`${CELL} text-ink-muted`}>
            {contact.activityCount === 0
              ? 'None yet'
              : `${contact.activityCount} ${contact.activityCount === 1 ? 'entry' : 'entries'}`}
          </td>
          <td className={CELL}>
            <SourceBadge source={contact.source} />
          </td>
        </>
      )}
    />
  );
}

// --------------------------------------------------------------- companies

export function Companies(): ReactNode {
  return (
    <RecordTable<CompanyRow>
      noun="companies"
      emptyHint="Companies appear here when the assistant identifies one from an email domain or signature."
      load={async () => {
        const { companies, total } = await api.listCompanies();
        return { rows: companies, total };
      }}
      keyOf={(company) => company.id}
      columns={['Company', 'Domain', 'Industry', 'Contacts', 'Deals', 'Source']}
      renderRow={(company) => (
        <>
          <td className={`${CELL} font-semibold text-ink`}>{company.name}</td>
          <td className={`${CELL} break-all text-ink-muted`}>{company.domain ?? '—'}</td>
          <td className={`${CELL} text-ink-muted`}>{company.industry ?? '—'}</td>
          <td className={`${CELL} text-ink-muted`}>{company.contactCount}</td>
          <td className={`${CELL} text-ink-muted`}>{company.dealCount}</td>
          <td className={CELL}>
            <SourceBadge source={company.source} />
          </td>
        </>
      )}
    />
  );
}

// ------------------------------------------------------------------- tasks

export function Tasks(): ReactNode {
  const [status, setStatus] = useState<string | null>('open');

  return (
    <RecordTable<TaskRow>
      noun="tasks"
      emptyHint="Follow-ups appear here when the assistant schedules one so a lead cannot die from absence."
      reloadKey={status ?? 'all'}
      load={async () => {
        const { tasks, total } = await api.listTasks(status ?? undefined);
        return { rows: tasks, total };
      }}
      keyOf={(task) => task.id}
      columns={['Follow-up', 'Linked to', 'Due', 'Priority', 'Status', 'Source']}
      toolbar={
        <>
          <FilterChip label="Open" active={status === 'open'} onClick={() => setStatus('open')} />
          <FilterChip label="Done" active={status === 'done'} onClick={() => setStatus('done')} />
          <FilterChip label="All" active={status === null} onClick={() => setStatus(null)} />
        </>
      }
      renderRow={(task) => {
        const overdue = isOverdue(task.dueAt, task.status);
        return (
          <>
            <td className={`${CELL} font-semibold text-ink`}>
              {task.title}
              {task.description ? (
                <p className="mt-0.5 text-meta font-normal text-ink-muted">{task.description}</p>
              ) : null}
            </td>
            <td className={`${CELL} text-ink-muted`}>
              {task.contactName ?? task.companyName ?? task.dealTitle ?? '—'}
            </td>
            <td className={`${CELL} ${overdue ? 'font-semibold text-danger' : 'text-ink-muted'}`}>
              {formatDate(task.dueAt)}
              {overdue ? <span className="ml-1 text-meta">overdue</span> : null}
            </td>
            <td className={`${CELL} text-ink-muted`}>{task.priority}</td>
            <td className={`${CELL} text-ink-muted`}>{taskStatusLabel(task.status)}</td>
            <td className={CELL}>
              <SourceBadge source={task.source} />
            </td>
          </>
        );
      }}
    />
  );
}

// ------------------------------------------------------------------- audit

const OUTCOME_CLASS: Record<string, string> = {
  ok: 'text-ink-muted',
  stopped: 'text-signal font-semibold',
  failed: 'text-danger font-semibold',
};

export function AuditLog(): ReactNode {
  const [actor, setActor] = useState<string | null>(null);

  return (
    <RecordTable<AuditRow>
      noun="events"
      emptyHint="Every automated decision is recorded here once an email has been processed."
      reloadKey={actor ?? 'all'}
      load={async () => {
        const { events, total } = await api.listAudit(actor ?? undefined);
        return { rows: events, total };
      }}
      keyOf={(event) => event.id}
      columns={['When', 'What happened', 'Who', 'Outcome']}
      toolbar={
        <>
          <FilterChip label="Everything" active={actor === null} onClick={() => setActor(null)} />
          <FilterChip label="The assistant" active={actor === 'ai'} onClick={() => setActor('ai')} />
          <FilterChip label="People" active={actor === 'human'} onClick={() => setActor('human')} />
          <FilterChip label="System" active={actor === 'system'} onClick={() => setActor('system')} />
        </>
      }
      renderRow={(event) => {
        const who = actorLabel(event.actor);
        const outcome = outcomeLabel(event.outcome);
        return (
          <>
            <td className={`${CELL} whitespace-nowrap text-ink-muted`}>
              {new Date(event.createdAt).toLocaleString(undefined, {
                day: 'numeric',
                month: 'short',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </td>
            <td className={CELL}>
              <span className="font-semibold text-ink">{eventLabel(event.eventType)}</span>
              <p className="mt-0.5 text-meta text-ink-muted">{event.summary}</p>
            </td>
            <td className={`${CELL} whitespace-nowrap text-ink-muted`}>
              <span aria-hidden="true">{who.marker} </span>
              {who.label}
              {event.actorId ? <p className="text-meta">{event.actorId}</p> : null}
            </td>
            <td className={`${CELL} whitespace-nowrap ${OUTCOME_CLASS[outcome.tone] ?? OUTCOME_CLASS.ok}`}>
              {outcome.label}
            </td>
          </>
        );
      }}
    />
  );
}
