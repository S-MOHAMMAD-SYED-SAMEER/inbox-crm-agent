import { Router, type Request, type Response, type NextFunction } from 'express';
import { operatorOf } from '../auth/middleware.ts';
import {
  handleGetEmail,
  handleIngest,
  handleListEmails,
  handleUnderstandEmail,
  handleUnderstandPending,
  handleResolveEmail,
  handleResolvePending,
  handleResolveMatch,
  handleDecideEmail,
  handleDecidePending,
  handleApprove,
  handleReject,
  handleExecute,
  handleListApprovals,
  handleExpireApprovals,
  handleRevise,
  type EmailHandlerDeps,
} from '../handlers/emails.ts';

/**
 * M1 email routes.
 *
 * Thin by policy: parse, call the handler, send the result. Errors are passed
 * to the app's terminal error handler so that every failure leaves through the
 * same envelope rather than through whatever each route decided to do.
 *
 * `wrap` exists because an async handler that rejects would otherwise be an
 * unhandled rejection rather than a 500 with a clean body.
 */
function wrap(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };
}

export function createEmailRouter(deps: EmailHandlerDeps): Router {
  const router = Router();

  router.post(
    '/emails/ingest',
    wrap(async (req, res) => {
      const result = await handleIngest(deps, req.body);
      res.status(result.status).json(result.body);
    }),
  );

  router.get(
    '/emails',
    wrap(async (req, res) => {
      const result = await handleListEmails(deps, req.query as Record<string, unknown>);
      res.status(result.status).json(result.body);
    }),
  );

  router.get(
    '/emails/:id',
    wrap(async (req, res) => {
      const result = await handleGetEmail(deps, req.params.id as string);
      res.status(result.status).json(result.body);
    }),
  );

  router.post(
    '/emails/understand',
    wrap(async (req, res) => {
      const result = await handleUnderstandPending(deps, req.body);
      res.status(result.status).json(result.body);
    }),
  );

  router.post(
    '/emails/:id/understand',
    wrap(async (req, res) => {
      const result = await handleUnderstandEmail(deps, req.params.id as string);
      res.status(result.status).json(result.body);
    }),
  );

  router.post(
    '/emails/resolve',
    wrap(async (req, res) => {
      const result = await handleResolvePending(deps, req.body);
      res.status(result.status).json(result.body);
    }),
  );

  router.post(
    '/emails/:id/resolve',
    wrap(async (req, res) => {
      const result = await handleResolveEmail(deps, req.params.id as string);
      res.status(result.status).json(result.body);
    }),
  );

  router.post(
    '/emails/:id/resolve-match',
    wrap(async (req, res) => {
      const result = await handleResolveMatch(deps, req.params.id as string, req.body, operatorOf(req));
      res.status(result.status).json(result.body);
    }),
  );

  router.post(
    '/emails/decide',
    wrap(async (req, res) => {
      const result = await handleDecidePending(deps, req.body);
      res.status(result.status).json(result.body);
    }),
  );

  router.post(
    '/emails/:id/decide',
    wrap(async (req, res) => {
      const result = await handleDecideEmail(deps, req.params.id as string);
      res.status(result.status).json(result.body);
    }),
  );

  router.get(
    '/approvals',
    wrap(async (req, res) => {
      const result = await handleListApprovals(deps, req.query as Record<string, unknown>);
      res.status(result.status).json(result.body);
    }),
  );

  router.post(
    '/approvals/expire',
    wrap(async (_req, res) => {
      const result = await handleExpireApprovals(deps);
      res.status(result.status).json(result.body);
    }),
  );

  router.post(
    '/decisions/:id/approve',
    wrap(async (req, res) => {
      const result = await handleApprove(deps, req.params.id as string, operatorOf(req));
      res.status(result.status).json(result.body);
    }),
  );

  // Creates a revision from a human's edits. Grants nothing on its own: it
  // ends with a *pending* approval on a new decision, which still has to go
  // through /approve and the executor's own verification.
  router.post(
    '/decisions/:id/revise',
    wrap(async (req, res) => {
      const result = await handleRevise(deps, req.params.id as string, req.body, operatorOf(req));
      res.status(result.status).json(result.body);
    }),
  );

  router.post(
    '/decisions/:id/reject',
    wrap(async (req, res) => {
      const result = await handleReject(deps, req.params.id as string, req.body, operatorOf(req));
      res.status(result.status).json(result.body);
    }),
  );

  // Runs a plan that needs no approval, and retries a failed one. Grants
  // nothing: the executor re-verifies for itself.
  router.post(
    '/decisions/:id/execute',
    wrap(async (req, res) => {
      const result = await handleExecute(deps, req.params.id as string);
      res.status(result.status).json(result.body);
    }),
  );

  router.post(
    '/decisions/:id/retry',
    wrap(async (req, res) => {
      const result = await handleExecute(deps, req.params.id as string);
      res.status(result.status).json(result.body);
    }),
  );

  return router;
}
