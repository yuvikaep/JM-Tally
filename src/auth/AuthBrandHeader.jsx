import styles from "./auth.module.css"

export function AuthBrandHeader() {
  return (
    <div className={styles.brandHeader}>
      <img src="/logo.png" alt="" className={styles.brandLogo} width={40} height={40} />
      <span className={styles.brandName}>JM Tally</span>
    </div>
  )
}
