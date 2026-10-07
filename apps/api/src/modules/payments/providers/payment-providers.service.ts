import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../../../common/errors/app.exception.js';
import { ErrorCode } from '../../../common/errors/error-codes.js';
import { AppConfigService } from '../../../config/app-config.service.js';
import { FakePaymentProvider } from './fake.provider.js';
import type { PaymentProvider, ProviderName } from './payment-provider.js';
import { VnpayProvider } from './vnpay.provider.js';

/** Looks up an enabled gateway by name ("vnpay", "fake"). */
@Injectable()
export class PaymentProvidersService {
  constructor(
    private readonly vnpay: VnpayProvider,
    readonly fake: FakePaymentProvider,
    private readonly config: AppConfigService,
  ) {}

  get defaultName(): ProviderName {
    return this.config.get('PAYMENT_PROVIDER');
  }

  find(name: string): PaymentProvider | null {
    if (name === 'vnpay' && this.vnpay.configured) return this.vnpay;
    if (name === 'fake' && this.fake.enabled) return this.fake;
    return null;
  }

  get(name: string): PaymentProvider {
    const provider = this.find(name);
    if (!provider) {
      throw new AppException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.PAYMENT_PROVIDER_UNAVAILABLE,
        `Payment provider "${name}" is not enabled`,
      );
    }
    return provider;
  }
}
