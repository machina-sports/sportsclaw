import type { Request, Response, NextFunction } from "express";

const DEV_MODE = (process.env.CLERK_SECRET_KEY ?? "").length <= 20;
const DEV_USER_ID = "dev_user_local";

// Clerk imports are conditional — only loaded when keys are present
let _clerkMiddleware: any;
let _getAuth: any;
let _requireAuth: any;

if (!DEV_MODE) {
  const clerk = await import("@clerk/express");
  _clerkMiddleware = clerk.clerkMiddleware;
  _getAuth = clerk.getAuth;
  _requireAuth = clerk.requireAuth;
}

export const clerkAuth = DEV_MODE
  ? (_req: Request, _res: Response, next: NextFunction) => next()
  : _clerkMiddleware();

export const authRequired = DEV_MODE
  ? (_req: Request, _res: Response, next: NextFunction) => next()
  : _requireAuth();

export function getClerkUserId(req: Request): string {
  if (DEV_MODE) return DEV_USER_ID;
  const { userId } = _getAuth(req);
  if (!userId) throw new Error("No userId in auth context");
  return userId;
}
