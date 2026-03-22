/* eslint-disable react-refresh/only-export-components -- module exports AuthProvider + useAuth hook */
import { createContext, useContext, useState, useEffect, useCallback } from "react"
import * as api from "./api.js"
import { clearSession } from "../authStorage.js"

const ONBOARD_KEY = "jmtally_onboarding_step"
const ACTIVE_CO_KEY = "jmtally_active_company_id"

const AuthContext = createContext(null)

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error("useAuth must be used within AuthProvider")
  return ctx
}

function readOnboardingStep() {
  try {
    return sessionStorage.getItem(ONBOARD_KEY) || ""
  } catch {
    return ""
  }
}

function writeOnboardingStep(step) {
  try {
    if (step) sessionStorage.setItem(ONBOARD_KEY, step)
    else sessionStorage.removeItem(ONBOARD_KEY)
  } catch {
    /* ignore */
  }
}

function readActiveCompanyId() {
  try {
    return localStorage.getItem(ACTIVE_CO_KEY) || ""
  } catch {
    return ""
  }
}

function writeActiveCompanyId(id) {
  try {
    if (id) localStorage.setItem(ACTIVE_CO_KEY, id)
    else localStorage.removeItem(ACTIVE_CO_KEY)
  } catch {
    /* ignore */
  }
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [companies, setCompanies] = useState([])
  const [activeCompany, setActiveCompanyState] = useState(null)
  const [loading, setLoading] = useState(true)
  const [onboardingStep, setOnboardingStepState] = useState("")

  const setActiveCompany = useCallback(c => {
    setActiveCompanyState(c)
    writeActiveCompanyId(c?.id || "")
  }, [])

  const setOnboardingStep = useCallback(step => {
    setOnboardingStepState(step)
    writeOnboardingStep(step)
  }, [])

  const refreshCompanies = useCallback(async () => {
    const data = await api.getCompanies()
    const list = data.companies || []
    setCompanies(list)
    return list
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const tok = api.getStoredToken()
      if (!tok) {
        setLoading(false)
        return
      }
      try {
        const me = await api.getMe()
        if (cancelled) return
        setUser(me.user)
        const list = await refreshCompanies()
        if (cancelled) return
        const ob = readOnboardingStep()
        if (ob === "company-setup" || ob === "plan") {
          setOnboardingStepState(ob)
        } else {
          const savedId = readActiveCompanyId()
          if (savedId && list.length) {
            const found = list.find(x => x.id === savedId)
            if (found) setActiveCompanyState(found)
          }
        }
      } catch {
        api.clearToken()
        setUser(null)
        setCompanies([])
        setActiveCompanyState(null)
        writeOnboardingStep("")
        writeActiveCompanyId("")
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [refreshCompanies])

  const login = useCallback(
    async ({ email, password }) => {
      const data = await api.login({ email, password })
      setUser(data.user)
      writeOnboardingStep("")
      setOnboardingStepState("")
      await refreshCompanies()
      setActiveCompanyState(null)
      writeActiveCompanyId("")
      return data
    },
    [refreshCompanies]
  )

  const signup = useCallback(
    async payload => {
      const data = await api.signup(payload)
      setUser(data.user)
      const co = data.company ? [data.company] : []
      setCompanies(co)
      setOnboardingStep("company-setup")
      setActiveCompanyState(null)
      writeActiveCompanyId("")
      return data
    },
    [setOnboardingStep]
  )

  const logout = useCallback(() => {
    api.clearToken()
    clearSession()
    writeOnboardingStep("")
    writeActiveCompanyId("")
    setUser(null)
    setCompanies([])
    setActiveCompanyState(null)
    setOnboardingStepState("")
  }, [])

  const updateCompanySetup = useCallback(
    async (companyId, payload) => {
      const data = await api.updateCompany(companyId, payload)
      await refreshCompanies()
      return data
    },
    [refreshCompanies]
  )

  const addCompany = useCallback(
    async payload => {
      const data = await api.createCompany(payload)
      await refreshCompanies()
      return data
    },
    [refreshCompanies]
  )

  const applyPlan = useCallback(
    async (companyId, plan) => {
      await api.updateCompany(companyId, { plan })
      const list = await refreshCompanies()
      const c = list.find(x => x.id === companyId)
      if (c) {
        setActiveCompany(c)
        setOnboardingStep("")
      }
    },
    [refreshCompanies, setActiveCompany, setOnboardingStep]
  )

  const completeCompanySetupPhase = useCallback(() => {
    setOnboardingStep("plan")
  }, [setOnboardingStep])

  const sendPasswordReset = useCallback(async email => {
    return api.forgotPassword({ email })
  }, [])

  const verifyOtpRequest = useCallback(async (email, otp) => {
    return api.verifyOtp({ email, otp })
  }, [])

  const resetPasswordRequest = useCallback(async (email, otp, newPassword) => {
    return api.resetPassword({ email, otp, newPassword })
  }, [])

  const value = {
    user,
    companies,
    activeCompany,
    loading,
    onboardingStep,
    setUser,
    setCompanies,
    setActiveCompany,
    setOnboardingStep,
    refreshCompanies,
    login,
    signup,
    logout,
    updateCompanySetup,
    addCompany,
    applyPlan,
    completeCompanySetupPhase,
    sendPasswordReset,
    verifyOtpRequest,
    resetPasswordRequest,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
