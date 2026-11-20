import nodemailer from 'nodemailer';
import { config, isTest } from '../config.js';
import { logger } from './logger.js';

// In tests mail is captured as JSON instead of being sent.
export const transport = isTest
  ? nodemailer.createTransport({ jsonTransport: true })
  : nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_PORT === 465,
      auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASS } : undefined,
    });

export const sentMail: { to: string; subject: string; text: string }[] = [];

export async function sendMail(to: string, subject: string, text: string) {
  const info = await transport.sendMail({ from: config.MAIL_FROM, to, subject, text });
  if (isTest) sentMail.push({ to, subject, text });
  logger.debug({ to, subject, id: info.messageId }, 'mail sent');
  return info.messageId as string;
}

/** Fire-and-forget for request handlers: a mail failure must not fail the request. */
export function sendMailLater(to: string, subject: string, text: string) {
  sendMail(to, subject, text).catch((err) => logger.error({ err, to, subject }, 'mail failed'));
}

export const appLink = (path: string) => `${config.APP_BASE_URL}${path}`;
