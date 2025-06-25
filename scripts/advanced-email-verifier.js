import { EmailVerifier } from "./email-verifier.js"
import fs from "fs/promises"

class AdvancedEmailVerifier extends EmailVerifier {
  constructor(options = {}) {
    super(options)
    this.cache = new Map()
    this.cacheExpiry = options.cacheExpiry || 3600000 // 1 hour
    this.rateLimiter = new Map()
    this.maxRequestsPerDomain = options.maxRequestsPerDomain || 10
    this.rateLimitWindow = options.rateLimitWindow || 60000 // 1 minute
  }

  /**
   * Verify email with caching and rate limiting
   */
  async verifyEmailAdvanced(email) {
    // Check cache first
    const cached = this.getFromCache(email)
    if (cached) {
      this.log(`Cache hit for ${email}`)
      return { ...cached, fromCache: true }
    }

    // Check rate limiting
    const domain = email.split("@")[1]
    if (!this.checkRateLimit(domain)) {
      return {
        email,
        isValid: false,
        status: "rate_limited",
        message: "Rate limit exceeded for domain",
      }
    }

    // Perform verification
    const result = await this.verifyEmail(email)

    // Cache the result
    this.addToCache(email, result)

    return result
  }

  /**
   * Get result from cache if not expired
   */
  getFromCache(email) {
    const cached = this.cache.get(email)
    if (cached && Date.now() - cached.timestamp < this.cacheExpiry) {
      return cached.result
    }
    if (cached) {
      this.cache.delete(email)
    }
    return null
  }

  /**
   * Add result to cache
   */
  addToCache(email, result) {
    this.cache.set(email, {
      result,
      timestamp: Date.now(),
    })
  }

  /**
   * Check if domain is within rate limits
   */
  checkRateLimit(domain) {
    const now = Date.now()
    const domainRequests = this.rateLimiter.get(domain) || []

    // Remove old requests outside the window
    const validRequests = domainRequests.filter((timestamp) => now - timestamp < this.rateLimitWindow)

    if (validRequests.length >= this.maxRequestsPerDomain) {
      return false
    }

    // Add current request
    validRequests.push(now)
    this.rateLimiter.set(domain, validRequests)

    return true
  }

  /**
   * Verify emails from CSV file
   */
  async verifyFromCsv(filePath, options = {}) {
    try {
      const content = await fs.readFile(filePath, "utf-8")
      const lines = content.split("\n").filter((line) => line.trim())

      // Skip header if present
      const startIndex = options.hasHeader ? 1 : 0
      const emailColumn = options.emailColumn || 0

      const emails = lines
        .slice(startIndex)
        .map((line) => {
          const columns = line.split(",")
          return columns[emailColumn]?.trim().replace(/"/g, "")
        })
        .filter((email) => email)

      console.log(`Found ${emails.length} emails to verify`)

      const results = await this.verifyMultiple(emails, {
        concurrency: options.concurrency || 3,
        delay: options.delay || 2000,
      })

      return results
    } catch (error) {
      throw new Error(`Failed to process CSV file: ${error.message}`)
    }
  }

  /**
   * Export results to CSV
   */
  async exportToCsv(results, outputPath) {
    const headers = ["Email", "IsValid", "Status", "Message", "SMTPResponse"]
    const csvContent = [
      headers.join(","),
      ...results.map((result) =>
        [
          `"${result.email}"`,
          result.isValid,
          `"${result.status}"`,
          `"${result.message}"`,
          `"${result.smtpResponse || ""}"`,
        ].join(","),
      ),
    ].join("\n")

    await fs.writeFile(outputPath, csvContent, "utf-8")
    console.log(`Results exported to ${outputPath}`)
  }

  /**
   * Generate verification report
   */
  generateReport(results) {
    const total = results.length
    const valid = results.filter((r) => r.isValid).length
    const invalid = results.filter((r) => !r.isValid && !["error", "rate_limited"].includes(r.status)).length
    const errors = results.filter((r) => ["error", "rate_limited"].includes(r.status)).length
    const temporary = results.filter((r) => r.status === "temporary_failure").length

    const statusCounts = {}
    results.forEach((result) => {
      statusCounts[result.status] = (statusCounts[result.status] || 0) + 1
    })

    return {
      summary: {
        total,
        valid,
        invalid,
        errors,
        temporary,
        validPercentage: ((valid / total) * 100).toFixed(2),
        invalidPercentage: ((invalid / total) * 100).toFixed(2),
      },
      statusBreakdown: statusCounts,
      recommendations: this.generateRecommendations(results),
    }
  }

  /**
   * Generate recommendations based on results
   */
  generateRecommendations(results) {
    const recommendations = []

    const errorRate = results.filter((r) => r.status === "error").length / results.length
    if (errorRate > 0.1) {
      recommendations.push("High error rate detected. Consider checking network connectivity and firewall settings.")
    }

    const tempFailureRate = results.filter((r) => r.status === "temporary_failure").length / results.length
    if (tempFailureRate > 0.05) {
      recommendations.push("High temporary failure rate. Consider retrying these emails later.")
    }

    const rateLimitedCount = results.filter((r) => r.status === "rate_limited").length
    if (rateLimitedCount > 0) {
      recommendations.push(
        `${rateLimitedCount} emails were rate limited. Consider reducing concurrency or increasing delays.`,
      )
    }

    const invalidFormatCount = results.filter((r) => r.status === "invalid_format").length
    if (invalidFormatCount > 0) {
      recommendations.push(`${invalidFormatCount} emails have invalid format. Consider data cleaning.`)
    }

    return recommendations
  }

  /**
   * Clear cache and rate limiting data
   */
  clearCache() {
    this.cache.clear()
    this.rateLimiter.clear()
    console.log("Cache and rate limiting data cleared")
  }
}

// Demonstration of advanced features
async function demonstrateAdvancedFeatures() {
  console.log("=== Advanced Email Verification Demo ===\n")

  const verifier = new AdvancedEmailVerifier({
    timeout: 15000,
    debug: true,
    cacheExpiry: 300000, // 5 minutes
    maxRequestsPerDomain: 5,
    rateLimitWindow: 30000, // 30 seconds
  })

  // Test with caching
  const testEmail = "test@gmail.com"

  console.log("--- Testing Caching ---")
  console.log("First verification (should hit server):")
  const result1 = await verifier.verifyEmailAdvanced(testEmail)
  console.log(`Result: ${result1.status}, From Cache: ${result1.fromCache || false}`)

  console.log("\nSecond verification (should use cache):")
  const result2 = await verifier.verifyEmailAdvanced(testEmail)
  console.log(`Result: ${result2.status}, From Cache: ${result2.fromCache || false}`)

  // Test rate limiting
  console.log("\n--- Testing Rate Limiting ---")
  const gmailEmails = [
    "test1@gmail.com",
    "test2@gmail.com",
    "test3@gmail.com",
    "test4@gmail.com",
    "test5@gmail.com",
    "test6@gmail.com", // This should be rate limited
  ]

  for (const email of gmailEmails) {
    const result = await verifier.verifyEmailAdvanced(email)
    console.log(`${email}: ${result.status}`)
  }

  // Generate and display report
  console.log("\n--- Generating Report ---")
  const allResults = [result1, result2]
  const report = verifier.generateReport(allResults)

  console.log("Verification Report:")
  console.log(JSON.stringify(report, null, 2))

  // Clear cache
  verifier.clearCache()
}

// Export for use in other modules
export { AdvancedEmailVerifier }

// Run demonstration if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  demonstrateAdvancedFeatures().catch(console.error)
}
