import { Suspense } from 'react';
import { FakeGateway } from './fake-gateway';

export const metadata = { title: 'Cổng thanh toán giả lập' };

export default function FakeGatewayPage() {
  return (
    <Suspense>
      <FakeGateway />
    </Suspense>
  );
}
