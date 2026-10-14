import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { AppShell } from './app/AppShell'
import { LoginPage } from './features/auth/LoginPage'
import { RequireAuth } from './features/auth/RequireAuth'
import { RequireRole } from './features/auth/RequireRole'
import { useAuth } from './features/auth/useAuth'
import { DashboardPage } from './pages/DashboardPage'
import { AssetListView } from './features/assets/AssetListView'
import { AssetDetailPage } from './features/assets/AssetDetailPage'
import { BulkStockListView } from './features/bulk/BulkStockListView'
import { BulkItemDetailPage } from './features/bulk/BulkItemDetailPage'
import { OnboardingListPage } from './features/onboarding/OnboardingListPage'
import { OnboardingDetailPage } from './features/onboarding/OnboardingDetailPage'
import { OffboardingListPage } from './features/offboarding/OffboardingListPage'
import { OffboardingTrackPage } from './features/offboarding/OffboardingTrackPage'
import { AdminPage } from './features/admin/AdminPage'
import { ImportHistoryPage } from './features/import/ImportHistoryPage'
import { DataBackupPage } from './features/data/DataBackupPage'

// html5-qrcode and xlsx (SheetJS) are both heavy — code-split so that
// weight only loads for someone who actually visits these pages.
const ScanPage = lazy(() => import('./features/scan/ScanPage').then((m) => ({ default: m.ScanPage })))
const ImportPage = lazy(() =>
  import('./features/import/ImportPage').then((m) => ({ default: m.ImportPage })),
)

export function App() {
  const { isPasswordRecovery } = useAuth()

  // Whatever URL a recovery session arrived on — the app root if Supabase
  // sent a clicked link, or /login for our own code flow — keep the user on
  // the "choose a new password" screen until they actually set one. Without
  // this, a clicked recovery link authenticates them and then RequireAuth
  // below waves them straight into the app, never asking for a new password.
  if (isPasswordRecovery) {
    return <LoginPage />
  }

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/*"
        element={
          <RequireAuth>
            <AppShell>
              <Routes>
                <Route path="/" element={<DashboardPage />} />
                <Route
                  path="/scan"
                  element={
                    <Suspense fallback={<p className="text-sm text-neutral-500">Loading…</p>}>
                      <ScanPage />
                    </Suspense>
                  }
                />
                <Route
                  path="/serialized-assets"
                  element={
                    <AssetListView
                      collection="serialized_assets"
                      title="Serialized Assets"
                      basePath="/serialized-assets"
                    />
                  }
                />
                <Route
                  path="/serialized-assets/:id"
                  element={
                    <AssetDetailPage collection="serialized_assets" basePath="/serialized-assets" />
                  }
                />
                <Route
                  path="/active-laptops-np"
                  element={
                    <AssetListView
                      collection="active_laptops_np"
                      title="Active Laptops (NP)"
                      basePath="/active-laptops-np"
                    />
                  }
                />
                <Route
                  path="/active-laptops-np/:id"
                  element={
                    <AssetDetailPage collection="active_laptops_np" basePath="/active-laptops-np" />
                  }
                />
                <Route
                  path="/monitors"
                  element={
                    <AssetListView collection="monitors" title="Monitors" basePath="/monitors" />
                  }
                />
                <Route
                  path="/monitors/:id"
                  element={<AssetDetailPage collection="monitors" basePath="/monitors" />}
                />
                <Route
                  path="/other-equipment"
                  element={
                    <AssetListView
                      collection="other_equipment"
                      title="Other Equipment"
                      basePath="/other-equipment"
                    />
                  }
                />
                <Route
                  path="/other-equipment/:id"
                  element={<AssetDetailPage collection="other_equipment" basePath="/other-equipment" />}
                />
                <Route path="/bulk-stock" element={<BulkStockListView />} />
                <Route path="/bulk-stock/:id" element={<BulkItemDetailPage />} />
                <Route path="/onboarding" element={<OnboardingListPage />} />
                <Route path="/onboarding/:id" element={<OnboardingDetailPage />} />
                <Route path="/offboarding" element={<OffboardingListPage />} />
                <Route path="/offboarding/:id" element={<OffboardingTrackPage />} />
                <Route
                  path="/admin"
                  element={
                    <RequireRole allow={['admin']}>
                      <AdminPage />
                    </RequireRole>
                  }
                />
                <Route
                  path="/import"
                  element={
                    <RequireRole allow={['admin', 'editor']}>
                      <Suspense fallback={<p className="text-sm text-neutral-500">Loading…</p>}>
                        <ImportPage />
                      </Suspense>
                    </RequireRole>
                  }
                />
                <Route
                  path="/import-history"
                  element={
                    <RequireRole allow={['admin', 'editor']}>
                      <ImportHistoryPage />
                    </RequireRole>
                  }
                />
                <Route
                  path="/data"
                  element={
                    <RequireRole allow={['admin']}>
                      <DataBackupPage />
                    </RequireRole>
                  }
                />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </AppShell>
          </RequireAuth>
        }
      />
    </Routes>
  )
}
