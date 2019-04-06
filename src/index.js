const {
  BaseKonnector,
  requestFactory,
  saveBills,
  log
} = require('cozy-konnector-libs')
const request = requestFactory({
  json: false,
  jar: true
})

const VENDOR = 'Ensap'
const baseUrl = 'https://ensap.gouv.fr'

module.exports = new BaseKonnector(start)

async function start(fields) {
  log('info', 'Authenticating ...')
  await authenticate(fields.login, fields.password)
  log('info', 'Successfully logged in')
  log('info', 'Parsing list of documents')
  const documents = await parseDocuments()
  await saveBills(documents, fields, {
    identifiers: ['ddfip']
  })
}

function authenticate(username, password) {
  return request({
    uri: `${baseUrl}/authentification`,
    method: 'POST',
    formData: { identifiant: username, secret: password }
  })
}

async function getYears() {
  try {
    const urlYears = `${baseUrl}/prive/listeanneeremuneration/v1`
    const req = await request({ uri: urlYears })
    return JSON.parse(req).donnee
  } catch (err) {
    log('error', err.message)
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
  for (const year of years) {
    // Get all the payrolls for a year
    const payrolls = await fetchPayrolls(year)
    for (const payroll of payrolls) {
      // For each payroll, get the pdf url and metadata
      const uuid = payroll.documentUuid
      const fileurl = `${baseUrl}/prive/telechargerdocumentremuneration/v1?documentUuid=${uuid}`
      const filename = payroll.nomDocument
      const date = new Date(payroll.dateDocument)
      const amount = parseFloat(
        payroll.libelle3.replace(' ', '').replace(',', '.')
      )
      const vendor = VENDOR
      const doc = {
        date,
        fileurl,
        filename,
        amount,
        vendor
      }
      docs.push(doc)
    }
  }
  return docs
}
