import { AdvancedEmailVerifier } from "./advanced-email-verifier.js"
import fs from "fs/promises"

/**
 * Bulk email processor for handling large datasets
 */
class BulkEmailProcessor {
  constructor(options = {}) {
    this.verifier = new AdvancedEmailVerifier({
      timeout: options.timeout || 10000,
      debug: options.debug || false,
      cacheExpiry: options.cacheExpiry || 3600000,
      maxRequestsPerDomain: options.maxRequestsPerDomain || 5,
      rateLimitWindow: options.rateLimitWindow || 60000,
    })

    this.batchSize = options.batchSize || 100
    this.concurrency = options.concurrency || 3
    this.delay = options.delay || 2000
    this.retryAttempts = options.retryAttempts || 2
  }

  /**
   * Process emails in batches with progress tracking
   */
  async processBulkEmails(emails, options = {}) {
    const startTime = Date.now()
    const totalEmails = emails.length
    let processedCount = 0
    let results = []

    console.log(`Starting bulk processing of ${totalEmails} emails`)
    console.log(`Batch size: ${this.batchSize}, Concurrency: ${this.concurrency}`)

    // Process in batches
    for (let i = 0; i < emails.length; i += this.batchSize) {
      const batch = emails.slice(i, i + this.batchSize)
      const batchNumber = Math.floor(i / this.batchSize) + 1
      const totalBatches = Math.ceil(emails.length / this.batchSize)

      console.log(`\nProcessing batch ${batchNumber}/${totalBatches} (${batch.length} emails)`)

      try {
        const batchResults = await this.processBatch(batch)
        results = results.concat(batchResults)
        processedCount += batch.length

        // Progress update
        const progress = ((processedCount / totalEmails) * 100).toFixed(1)
        const elapsed = (Date.now() - startTime) / 1000
        const rate = processedCount / elapsed
        const eta = (totalEmails - processedCount) / rate

        console.log(`Progress: ${progress}% (${processedCount}/${totalEmails})`)
        console.log(`Rate: ${rate.toFixed(2)} emails/sec, ETA: ${eta.toFixed(0)}s`)

        // Save intermediate results
        if (options.saveIntermediate && batchNumber % 5 === 0) {
          await this.saveResults(results, `intermediate_results_batch_${batchNumber}.json`)
        }
      } catch (error) {
        console.error(`Error processing batch ${batchNumber}:`, error.message)

        // Add error results for failed batch
        const errorResults = batch.map((email) => ({
          email,
          isValid: false,
          status: "batch_error",
          message: `Batch processing failed: ${error.message}`,
        }))
        results = results.concat(errorResults)
      }

      // Delay between batches
      if (i + this.batchSize < emails.length) {
        console.log(`Waiting ${this.delay}ms before next batch...`)
        await new Promise((resolve) => setTimeout(resolve, this.delay))
      }
    }

    const totalTime = (Date.now() - startTime) / 1000
    console.log(`\nBulk processing completed in ${totalTime.toFixed(2)}s`)
    console.log(`Average rate: ${(totalEmails / totalTime).toFixed(2)} emails/sec`)

    return results
  }

  /**
   * Process a single batch of emails
   */
  async processBatch(emails) {
    const results = []

    // Process emails in smaller concurrent groups
    for (let i = 0; i < emails.length; i += this.concurrency) {
      const group = emails.slice(i, i + this.concurrency)
      const promises = group.map((email) => this.verifyWithRetry(email))

      const groupResults = await Promise.allSettled(promises)

      for (let j = 0; j < groupResults.length; j++) {
        const result = groupResults[j]
        if (result.status === "fulfilled") {
          results.push(result.value)
        } else {
          results.push({
            email: group[j],
            isValid: false,
            status: "error",
            message: result.reason.message,
          })
        }
      }

      // Small delay between concurrent groups
      if (i + this.concurrency < emails.length) {
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    }

    return results
  }

  /**
   * Verify email with retry logic
   */
  async verifyWithRetry(email, attempt = 1) {
    try {
      const result = await this.verifier.verifyEmailAdvanced(email)

      // Retry on temporary failures
      if (result.status === "temporary_failure" && attempt <= this.retryAttempts) {
        console.log(`Retrying ${email} (attempt ${attempt + 1}/${this.retryAttempts + 1})`)
        await new Promise((resolve) => setTimeout(resolve, 5000 * attempt)) // Exponential backoff
        return this.verifyWithRetry(email, attempt + 1)
      }

      return result
    } catch (error) {
      if (attempt <= this.retryAttempts) {
        console.log(`Retrying ${email} due to error (attempt ${attempt + 1}/${this.retryAttempts + 1})`)
        await new Promise((resolve) => setTimeout(resolve, 3000 * attempt))
        return this.verifyWithRetry(email, attempt + 1)
      }
      throw error
    }
  }

  /**
   * Save results to file
   */
  async saveResults(results, filename) {
    try {
      await fs.writeFile(filename, JSON.stringify(results, null, 2))
      console.log(`Results saved to ${filename}`)
    } catch (error) {
      console.error(`Failed to save results: ${error.message}`)
    }
  }

  /**
   * Load emails from various file formats
   */
  async loadEmailsFromFile(filePath) {
    const ext = filePath.split(".").pop().toLowerCase()

    try {
      const content = await fs.readFile(filePath, "utf-8")

      switch (ext) {
        case "txt":
          return content
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line && this.isValidEmailFormat(line))

        case "csv":
          const lines = content.split("\n").filter((line) => line.trim())
          // Assume first column contains emails, skip header
          return lines
            .slice(1)
            .map((line) => {
              const email = line.split(",")[0].trim().replace(/"/g, "")
              return this.isValidEmailFormat(email) ? email : null
            })
            .filter((email) => email)

        case "json":
          const data = JSON.parse(content)
          if (Array.isArray(data)) {
            return data
              .filter((item) =>
                typeof item === "string"
                  ? this.isValidEmailFormat(item)
                  : item.email && this.isValidEmailFormat(item.email),
              )
              .map((item) => (typeof item === "string" ? item : item.email))
          }
          break

        default:
          throw new Error(`Unsupported file format: ${ext}`)
      }
    } catch (error) {
      throw new Error(`Failed to load emails from file: ${error.message}`)
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
   * Generate comprehensive report
   */
  generateDetailedReport(results) {
    const report = this.verifier.generateReport(results)

    // Add domain analysis
    const domainStats = {}
    results.forEach((result) => {
      if (result.email && result.email.includes("@")) {
        const domain = result.email.split("@")[1]
        if (!domainStats[domain]) {
          domainStats[domain] = { total: 0, valid: 0, invalid: 0, errors: 0 }
        }
        domainStats[domain].total++
        if (result.isValid) {
          domainStats[domain].valid++
        } else if (["error", "rate_limited", "connection_failed"].includes(result.status)) {
          domainStats[domain].errors++
        } else {
          domainStats[domain].invalid++
        }
      }
    })

    // Sort domains by total count
    const sortedDomains = Object.entries(domainStats)
      .sort(([, a], [, b]) => b.total - a.total)
      .slice(0, 10) // Top 10 domains

    report.domainAnalysis = {
      totalDomains: Object.keys(domainStats).length,
      topDomains: sortedDomains.map(([domain, stats]) => ({
        domain,
        ...stats,
        validRate: ((stats.valid / stats.total) * 100).toFixed(1) + "%",
      })),
    }

    return report
  }
}

// Demonstration of bulk processing
async function demonstrateBulkProcessing() {
  console.log("=== Bulk Email Processing Demo ===\n")

  const processor = new BulkEmailProcessor({
    debug: false,
    batchSize: 10,
    concurrency: 2,
    delay: 1000,
    retryAttempts: 1,
  })

  // Sample email list for demonstration
  const sampleEmails = [
    "test1@gmail.com",
    "test2@yahoo.com",
    "invalid-email",
    "test3@outlook.com",
    "nonexistent@gmail.com",
    "test4@hotmail.com",
    "admin@example.com",
    "test5@protonmail.com",
    "user@nonexistentdomain12345.com",
    "test6@icloud.com",
  ]

  console.log(`Processing ${sampleEmails.length} sample emails...`)

  try {
    const results = await processor.processBulkEmails(sampleEmails, {
      saveIntermediate: false,
    })

    // Save final results
    await processor.saveResults(results, "bulk_verification_results.json")

    // Generate and display detailed report
    const report = processor.generateDetailedReport(results)
    console.log("\n=== Detailed Report ===")
    console.log(JSON.stringify(report, null, 2))

    // Export to CSV
    const csvContent = [
      "Email,IsValid,Status,Message",
      ...results.map((r) => `"${r.email}",${r.isValid},"${r.status}","${r.message}"`),
    ].join("\n")

    await fs.writeFile("bulk_verification_results.csv", csvContent)
    console.log("\nResults exported to bulk_verification_results.csv")
  } catch (error) {
    console.error("Bulk processing failed:", error.message)
  }
}

// Export for use in other modules
export { BulkEmailProcessor }

// Run demonstration if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  demonstrateBulkProcessing().catch(console.error)
}
