import { useState } from "react"
import { useAuth } from "./AuthContext.jsx"
import { LoginPage } from "./LoginPage.jsx"
import { SignupPage } from "./SignupPage.jsx"
import { ForgotPasswordPage } from "./ForgotPasswordPage.jsx"
import { CompanySetupPage } from "./CompanySetupPage.jsx"
import { PlanSelectionPage } from "./PlanSelectionPage.jsx"
import { CompanyPickerPage } from "./CompanyPickerPage.jsx"

export function AuthRouter() {
  const { user, onboardingStep, activeCompany } = useAuth()
  const [guestScreen, setGuestScreen] = useState("login")

  if (!user) {
    if (guestScreen === "signup") return <SignupPage onNavigate={setGuestScreen} />
    if (guestScreen === "forgot") return <ForgotPasswordPage onNavigate={setGuestScreen} />
    return <LoginPage onNavigate={setGuestScreen} />
  }
  if (onboardingStep === "company-setup") return <CompanySetupPage />
  if (onboardingStep === "plan") return <PlanSelectionPage />
  if (!activeCompany) return <CompanyPickerPage />
  return null
}
