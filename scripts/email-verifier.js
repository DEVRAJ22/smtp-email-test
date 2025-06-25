import net from "net"
import dns from "dns"
import { promisify } from "util"

const resolveMx = promisify(dns.resolveMx)

class EmailVerifier {
  constructor(options = {}) {
    this.timeout = options.timeout || 10000
    this.fromEmail = options.fromEmail || "test@example.com"
    this.maxRetries = options.maxRetries || 2
    this.debug = options.debug || false
  }

  /**
   * Verify email address deliverability
   * @param {string} email - Email address to verify
   * @returns {Promise<Object>} Verification result
   */
  async verifyEmail(email) {
    try {
      // Validate email format
      if (!this.isValidEmailFormat(email)) {
        return {
          email,
          isValid: false,
          status: "invalid_format",
          message: "Invalid email format",
        }
      }

      const domain = email.split("@")[1]

      // Get MX records
      const mxRecords = await this.getMxRecords(domain)
      if (!mxRecords || mxRecords.length === 0) {
        return {
          email,
          isValid: false,
          status: "no_mx_record",
          message: "No MX record found for domain",
        }
      }

      // Try verification with each MX record
      for (const mx of mxRecords) {
        try {
          const result = await this.verifyWithMxRecord(email, mx.exchange)
          if (result.status !== "connection_failed") {
            return result
          }
        } catch (error) {
          this.log(`Failed to verify with MX ${mx.exchange}: ${error.message}`)
          continue
        }
      }

      return {
        email,
        isValid: false,
        status: "connection_failed",
        message: "Could not connect to any mail server",
      }
    } catch (error) {
      return {
        email,
        isValid: false,
        status: "error",
        message: error.message,
      }
    }
  }

  /**
   * Verify email with specific MX record
   * @param {string} email - Email to verify
   * @param {string} mxHost - MX host to connect to
   * @returns {Promise<Object>} Verification result
   */
  async verifyWithMxRecord(email, mxHost) {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket()
      let response = ""
      let step = "connect"
      let isResolved = false

      const cleanup = () => {
        if (!socket.destroyed) {
          socket.destroy()
        }
      }

      const resolveOnce = (result) => {
        if (!isResolved) {
          isResolved = true
          cleanup()
          resolve(result)
        }
      }

      const rejectOnce = (error) => {
        if (!isResolved) {
          isResolved = true
          cleanup()
          reject(error)
        }
      }

      // Set timeout
      const timeoutId = setTimeout(() => {
        rejectOnce(new Error("Connection timeout"))
      }, this.timeout)

      socket.setTimeout(this.timeout)

      socket.on("connect", () => {
        this.log(`Connected to ${mxHost}`)
      })

      socket.on("data", (data) => {
        response += data.toString()

        // Process complete lines
        const lines = response.split("\r\n")
        response = lines.pop() || "" // Keep incomplete line

        for (const line of lines) {
          if (line.trim()) {
            this.log(`Received: ${line}`)
            this.handleSmtpResponse(socket, line, email, step, resolveOnce)
            step = this.getNextStep(step, line)
          }
        }
      })

      socket.on("error", (error) => {
        this.log(`Socket error: ${error.message}`)
        rejectOnce(error)
      })

      socket.on("timeout", () => {
        rejectOnce(new Error("Socket timeout"))
      })

      socket.on("close", () => {
        if (!isResolved) {
          rejectOnce(new Error("Connection closed unexpectedly"))
        }
      })

      // Connect to MX server
      socket.connect(25, mxHost)

      // Cleanup timeout when done
      socket.on("end", () => {
        clearTimeout(timeoutId)
      })
    })
  }

  /**
   * Handle SMTP responses and send appropriate commands
   */
  handleSmtpResponse(socket, line, email, step, resolve) {
    const code = Number.parseInt(line.substring(0, 3))

    switch (step) {
      case "connect":
        if (code === 220) {
          this.sendCommand(socket, `EHLO ${this.getLocalHostname()}`)
        } else {
          resolve({
            email,
            isValid: false,
            status: "connection_rejected",
            message: `Connection rejected: ${line}`,
            smtpResponse: line,
          })
        }
        break

      case "ehlo":
        if (code === 250) {
          this.sendCommand(socket, `MAIL FROM:<${this.fromEmail}>`)
        } else {
          // Try HELO if EHLO fails
          this.sendCommand(socket, `HELO ${this.getLocalHostname()}`)
        }
        break

      case "helo":
        if (code === 250) {
          this.sendCommand(socket, `MAIL FROM:<${this.fromEmail}>`)
        } else {
          resolve({
            email,
            isValid: false,
            status: "handshake_failed",
            message: `Handshake failed: ${line}`,
            smtpResponse: line,
          })
        }
        break

      case "mail_from":
        if (code === 250) {
          this.sendCommand(socket, `RCPT TO:<${email}>`)
        } else {
          resolve({
            email,
            isValid: false,
            status: "mail_from_rejected",
            message: `MAIL FROM rejected: ${line}`,
            smtpResponse: line,
          })
        }
        break

      case "rcpt_to":
        this.sendCommand(socket, "QUIT")

        if (code === 250) {
          resolve({
            email,
            isValid: true,
            status: "valid",
            message: "Email address is valid",
            smtpResponse: line,
          })
        } else if (code >= 500 && code <= 599) {
          resolve({
            email,
            isValid: false,
            status: "invalid",
            message: `Email address rejected: ${line}`,
            smtpResponse: line,
          })
        } else if (code >= 400 && code <= 499) {
          resolve({
            email,
            isValid: false,
            status: "temporary_failure",
            message: `Temporary failure: ${line}`,
            smtpResponse: line,
          })
        } else {
          resolve({
            email,
            isValid: false,
            status: "unknown_response",
            message: `Unknown response: ${line}`,
            smtpResponse: line,
          })
        }
        break
    }
  }

  /**
   * Get next step based on current step and response
   */
  getNextStep(currentStep, response) {
    const code = Number.parseInt(response.substring(0, 3))

    switch (currentStep) {
      case "connect":
        return "ehlo"
      case "ehlo":
        return code === 250 ? "mail_from" : "helo"
      case "helo":
        return "mail_from"
      case "mail_from":
        return "rcpt_to"
      case "rcpt_to":
        return "quit"
      default:
        return currentStep
    }
  }

  /**
   * Send SMTP command
   */
  sendCommand(socket, command) {
    this.log(`Sending: ${command}`)
    socket.write(command + "\r\n")
  }

  /**
   * Get MX records for domain
   */
  async getMxRecords(domain) {
    try {
      const records = await resolveMx(domain)
      return records.sort((a, b) => a.priority - b.priority)
    } catch (error) {
      this.log(`MX lookup failed for ${domain}: ${error.message}`)
      return null
    }
  }

  /**
   * Validate email format
   */
  isValidEmailFormat(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    return emailRegex.test(email)
  }

  /**
   * Get local hostname
   */
  getLocalHostname() {
    return "localhost"
  }

  /**
   * Log debug messages
   */
  log(message) {
    if (this.debug) {
      console.log(`[EmailVerifier] ${message}`)
    }
  }

  /**
   * Verify multiple emails with rate limiting
   */
  async verifyMultiple(emails, options = {}) {
    const concurrency = options.concurrency || 5
    const delay = options.delay || 1000
    const results = []

    for (let i = 0; i < emails.length; i += concurrency) {
      const batch = emails.slice(i, i + concurrency)
      const batchPromises = batch.map((email) => this.verifyEmail(email))

      const batchResults = await Promise.allSettled(batchPromises)

      for (const result of batchResults) {
        if (result.status === "fulfilled") {
          results.push(result.value)
        } else {
          results.push({
            email: "unknown",
            isValid: false,
            status: "error",
            message: result.reason.message,
          })
        }
      }

      // Add delay between batches to avoid overwhelming servers
      if (i + concurrency < emails.length) {
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }

    return results
  }
}

// Example usage and testing
async function demonstrateEmailVerification() {
  console.log("=== Email Deliverability Verification Demo ===\n")

  const verifier = new EmailVerifier({
    timeout: 15000,
    fromEmail: "test@example.com",
    debug: true,
  })

  // Test emails (mix of valid, invalid, and edge cases)
  const testEmails = [
    "test@gmail.com",
    "nonexistent@gmail.com",
    "invalid-email",
    "test@nonexistentdomain12345.com",
    "admin@example.com",
  ]

  console.log("Testing individual email verification:\n")

  for (const email of testEmails) {
    console.log(`\n--- Verifying: ${email} ---`)
    try {
      const result = await verifier.verifyEmail(email)
      console.log("Result:", JSON.stringify(result, null, 2))
    } catch (error) {
      console.error(`Error verifying ${email}:`, error.message)
    }
  }

  console.log("\n\n=== Batch Verification Demo ===\n")

  try {
    const batchResults = await verifier.verifyMultiple(testEmails, {
      concurrency: 2,
      delay: 2000,
    })

    console.log("Batch Results:")
    batchResults.forEach((result, index) => {
      console.log(`${index + 1}. ${result.email}: ${result.status} - ${result.message}`)
    })

    // Summary statistics
    const validCount = batchResults.filter((r) => r.isValid).length
    const invalidCount = batchResults.filter((r) => !r.isValid && r.status !== "error").length
    const errorCount = batchResults.filter((r) => r.status === "error").length

    console.log("\n--- Summary ---")
    console.log(`Total emails tested: ${batchResults.length}`)
    console.log(`Valid emails: ${validCount}`)
    console.log(`Invalid emails: ${invalidCount}`)
    console.log(`Errors: ${errorCount}`)
  } catch (error) {
    console.error("Batch verification error:", error.message)
  }
}

// Export for use in other modules
export { EmailVerifier }

// Run demonstration if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  demonstrateEmailVerification().catch(console.error)
}
