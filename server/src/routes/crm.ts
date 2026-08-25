import { Router, type NextFunction, type Request, type Response } from 'express';
import {
  handleListAudit,
  handleListCompanies,
  handleListContacts,
  handleListDeals,
  handleListTasks,
  type CrmDeps,
} from '../handlers/crm.ts';

// CRM read routes (M6-C).
//
// GET only. Mounted after `requireSession`, so every one of these is behind
// authentication without needing to say so — the app's gate is ordered such
// that anything added below it is protected by default (M5-A).
//
// There is deliberately no POST, PUT, PATCH or DELETE here. The executor is the
// only thing that writes to the CRM, and it does so after an approval, through
// the closed action registry. An endpoint that let the browser edit a deal
// would be a second write path into the state the whole approval workflow
// exists to protect.

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };

export function createCrmRouter(deps: CrmDeps): Router {
  const router = Router();

  const read = (
    path: string,
    handler: (deps: CrmDeps, query: Record<string, unknown>) => Promise<{ status: number; body: unknown }>,
  ): void => {
    router.get(
      path,
      wrap(async (req, res) => {
        const result = await handler(deps, req.query as Record<string, unknown>);
        res.status(result.status).json(result.body);
      }),
    );
  };

  read('/deals', handleListDeals);
  read('/contacts', handleListContacts);
  read('/companies', handleListCompanies);
  read('/tasks', handleListTasks);
  read('/audit', handleListAudit);

  return router;
}
