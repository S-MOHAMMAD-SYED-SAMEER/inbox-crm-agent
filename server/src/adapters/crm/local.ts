import type { Repositories } from '../../db/repositories/index.ts';
import { normaliseCompanyName } from '../../domain/crm.ts';
import type { CrmReader, TimelineItem } from './types.ts';

// The local CRM reader — this database, through the repositories.
//
// `supportsAtomicity: true` is not a boast, it is a claim the conformance
// suite checks: a local plan runs inside one database transaction, so a
// multi-action plan either lands completely or not at all. The HubSpot adapter
// (§24) will have to answer `false` here and accept the extra approval
// requirement that follows.

export function createLocalCrmReader(repos: Repositories): CrmReader {
  return {
    name: 'local',
    supportsAtomicity: true,

    async findContactByEmail(email) {
      return repos.contacts.findByEmail(email);
    },

    async findCompanyByDomain(domain) {
      return repos.companies.findByDomain(domain);
    },

    async searchCompaniesByName(nameNorm) {
      // Normalised again rather than trusted: the caller may pass a raw name,
      // and normalising an already-normalised name is a no-op. Cheap
      // idempotence beats a precondition nobody reads.
      return repos.companies.findByNameNorm(normaliseCompanyName(nameNorm));
    },

    async getTimeline(entityType, id): Promise<TimelineItem[]> {
      const [activities, notes] = await Promise.all([
        repos.activities.listForEntity(entityType, id),
        repos.notes.listForEntity(entityType, id),
      ]);

      const items: TimelineItem[] = [
        ...activities.map((activity) => ({
          kind: 'activity' as const,
          id: activity.id,
          occurredAt: activity.occurredAt,
          title: activity.subject ?? activity.type,
          body: activity.body,
          source: activity.source,
        })),
        ...notes.map((note) => ({
          kind: 'note' as const,
          id: note.id,
          occurredAt: note.createdAt,
          title: `Note by ${note.author}`,
          body: note.body,
          source: note.source,
        })),
      ];

      // Newest first, and ties broken by id so the order is stable across runs
      // — a timeline that reshuffles between identical requests looks broken
      // even when the data is right.
      return items.sort((a, b) => {
        const byTime = b.occurredAt.localeCompare(a.occurredAt);
        return byTime !== 0 ? byTime : a.id.localeCompare(b.id);
      });
    },
  };
}
