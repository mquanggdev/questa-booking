import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import { AppConfigService } from '../../config/app-config.service.js';
import type { Email } from './emails.js';

/** SMTP (Mailpit locally: every email lands in the inbox at :8025). */
@Injectable()
export class MailerService implements OnApplicationShutdown {
  private readonly transport: Transporter;

  constructor(private readonly config: AppConfigService) {
    this.transport = nodemailer.createTransport(config.get('SMTP_URL'));
  }

  /**
   * messageId is fixed per event: if a crash makes the consumer send the
   * same email twice, mail clients can tell it is the same message.
   */
  async send(to: string, email: Email, messageId: string): Promise<void> {
    await this.transport.sendMail({
      from: this.config.get('MAIL_FROM'),
      to,
      subject: email.subject,
      text: email.text,
      html: email.html,
      attachments: email.attachments,
      messageId,
    });
  }

  onApplicationShutdown(): void {
    this.transport.close();
  }
}
