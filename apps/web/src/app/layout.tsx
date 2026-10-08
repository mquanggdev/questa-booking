import type { Metadata } from 'next';
import { Be_Vietnam_Pro, Geist_Mono } from 'next/font/google';
import { Providers } from '@/components/providers';
import { SiteHeader } from '@/components/site-header';
import './globals.css';

// A typeface designed for Vietnamese diacritics.
const sans = Be_Vietnam_Pro({
  variable: '--font-sans',
  subsets: ['latin', 'vietnamese'],
  weight: ['400', '500', '600', '700'],
});

const mono = Geist_Mono({ variable: '--font-mono', subsets: ['latin'] });

export const metadata: Metadata = {
  title: { default: 'Questa — Vé concert', template: '%s · Questa' },
  description:
    'Mua vé concert: chọn ghế, giữ vé, thanh toán và nhận vé QR. Demo của dự án Questa Booking.',
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html
      lang="vi"
      className={`${sans.variable} ${mono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        <Providers>
          <SiteHeader />
          <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">
            {children}
          </main>
          <footer className="border-t py-6 text-center text-xs text-muted-foreground">
            Questa Booking · dự án portfolio · thanh toán chạy trên cổng giả lập
            hoặc VNPay sandbox, không có tiền thật
          </footer>
        </Providers>
      </body>
    </html>
  );
}
