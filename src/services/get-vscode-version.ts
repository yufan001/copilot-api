const FALLBACK = "1.116.0"

export async function getVSCodeVersion() {
  const controller = new AbortController()
  const timeout = setTimeout(() => {
    controller.abort()
  }, 5000)

  try {
    const response = await fetch(
      "https://update.code.visualstudio.com/api/update/linux-x64/stable/latest",
      {
        signal: controller.signal,
      },
    )

    const data = (await response.json()) as { productVersion?: string }

    if (data.productVersion) {
      return data.productVersion
    }

    return FALLBACK
  } catch {
    return FALLBACK
  } finally {
    clearTimeout(timeout)
  }
}
