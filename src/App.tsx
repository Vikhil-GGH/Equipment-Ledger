import { Navigate, Route, Routes } from 'react-router-dom'
import { AppShell } from './app/AppShell'
import { LoginPage } from './features/auth/LoginPage'
import { RequireAuth } from './features/auth/RequireAuth'
import { DashboardPage } from './pages/DashboardPage'
import { AssetListView } from './features/assets/AssetListView'
import { AssetDetailPage } from './features/assets/AssetDetailPage'
import { BulkStockListView } from './features/bulk/BulkStockListView'
import { BulkItemDetailPage } from './features/bulk/BulkItemDetailPage'
import { OnboardingListPage } from './features/onboarding/OnboardingListPage'
import { OnboardingDetailPage } from './features/onboarding/OnboardingDetailPage'
import { OffboardingListPage } from './features/offboarding/OffboardingListPage'
import { OffboardingTrackPage } from './features/offboarding/OffboardingTrackPage'

export function App() {
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
                <Route path="/bulk-stock" element={<BulkStockListView />} />
                <Route path="/bulk-stock/:id" element={<BulkItemDetailPage />} />
                <Route path="/onboarding" element={<OnboardingListPage />} />
                <Route path="/onboarding/:id" element={<OnboardingDetailPage />} />
                <Route path="/offboarding" element={<OffboardingListPage />} />
                <Route path="/offboarding/:id" element={<OffboardingTrackPage />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </AppShell>
          </RequireAuth>
        }
      />
    </Routes>
  )
}
