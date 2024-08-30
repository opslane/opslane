import './globals.css'
import { Inter } from 'next/font/google'
import { SideNavbar } from '@/components/SideNavbar'

const inter = Inter({ subsets: ['latin'] })

export const metadata = {
  title: 'Opslane',
  description: 'AI On-Call Co-Pilot',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className={inter.className}>
      <body>
        <div className="flex">
          <SideNavbar />
          <main className="flex-1">
            {children}
          </main>
        </div>
      </body>
    </html>
  )
}
