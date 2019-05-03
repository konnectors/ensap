process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://ea724fef74ee48889c9a788643f96a48@sentry.cozycloud.cc/123'

const {
  BaseKonnector,
  requestFactory,
  saveBills,
  saveFiles,
  log,
  errors
} = require('cozy-konnector-libs')
const request = requestFactory({
  debug: true,
  json: false,
  jar: true
})

const VENDOR = 'Ensap'
const baseUrl = 'https://ensap.gouv.fr'

module.exports = new BaseKonnector(start)

async function start(fields) {
  log('info', 'Authenticating ...')
  log('info', 'Successfully logged in')
  await authenticate(fields.login, fields.password)
  log('info', 'Parsing list of documents')
  const { docs, bills } = await parseDocuments()
  log('info', 'Saving bills...')
  await saveBills(bills, fields, {
    identifiers: ['ddfip', 'drfip']
  })
  log('info', 'Saving docs...')
  await saveFiles(docs, fields.folderPath, {
    contentType: 'application/pdf'
  })
}

async function authenticate(username, password) {
  const resp = await request({
    uri: `${baseUrl}/authentification`,
    method: 'POST',
    formData: { identifiant: username, secret: password }
  })
  if (resp.includes('Identifiant ou mot de passe erroné')) {
    throw new Error(errors.LOGIN_FAILED)
  } else if (resp.includes('Authentification OK')) {
    return
  } else if (resp.includes('Ce compte est temporairement bloqué pendant')) {
    log('error', resp)
    throw new Error('LOGIN_FAILED.TOO_MANY_ATTEMPTS')
  } else {
    log('error', resp)
    throw new Error(errors.VENDOR_DOWN)
  }
}

async function getYears() {
  try {
    const urlYears = `${baseUrl}/prive/listeanneeremuneration/v1`
    const req = await request({ uri: urlYears })
    return JSON.parse(req).donnee
  } catch (err) {
    log('error', err.message)
    throw new Error(errors.VENDOR_DOWN)
  }
}

async function fetchPayrolls(year) {
  try {
    // For each year, list all the available payrolls
    const urlPayrolls = `${baseUrl}/prive/anneeremuneration/v1/${year}`
    const req = await request({ uri: urlPayrolls })
    const payrolls = JSON.parse(req).donnee
    return payrolls
  } catch (err) {
    log('error', err.message)
  }
}

async function parseDocuments() {
  // Get the available years for payrolls
  const years = await getYears()
  const docs = []
  const bills = []
  for (const year of years) {
    // Get all the payrolls for a year
    const payrolls = await fetchPayrolls(year)
    for (const payroll of payrolls) {
      // For each payroll, get the pdf url and metadata
      const uuid = payroll.documentUuid
      const fileurl = `${baseUrl}/prive/telechargerdocumentremuneration/v1?documentUuid=${uuid}`
      // Try to replace _XX_ known type_
      let filename = payroll.nomDocument.replace(
        /_AF_/,
        '_Attestation_fiscale_'
      )
      filename = filename.replace(/_BP_/, '_Bulletin_de_paie_')
      filename = filename.replace(/_DR_/, '_Décompte_de_rappel_')
      // Date is set to 22 of the month for easier matching, if not BP is always at 1st
      let datePlus21 = new Date(payroll.dateDocument)
      datePlus21.setDate(datePlus21.getDate() + 21)
      const amount = parseFloat(
        payroll.libelle3.replace(' ', '').replace(',', '.')
      )
      const vendor = VENDOR

      // This doc have no amount in libelle3, make a file only.
      if (payroll.icone === 'rappel' || payroll.icone === 'attestation') {
        const doc = {
          fileurl,
          filename
        }
        docs.push(doc)
      } else if (payroll.icone === 'document') {
        // This doc have amount, it's a bill !
        const doc = {
          date: datePlus21,
          fileurl,
          filename,
          amount,
          isRefund: true,
          vendor,
          vendorRef: uuid,
          type: 'income'
        }
        bills.push(doc)
      } else {
        log(
          'warn',
          `Unkown type for one doc, discarding this one : ${payroll.icone}`
        )
      }
    }
  }
  return { docs, bills }
}
