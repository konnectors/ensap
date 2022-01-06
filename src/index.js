process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://783765ad8f0542ce9d961b2ef487cd57@errors.cozycloud.cc/20'

const {
  BaseKonnector,
  requestFactory,
  log,
  errors,
  utils,
  cozyClient
} = require('cozy-konnector-libs')

const models = cozyClient.new.models
const { Qualification } = models.document

const request = requestFactory({
  debug: false,
  json: true,
  jar: true
})

const VENDOR = 'Ensap'
const baseUrl = 'https://ensap.gouv.fr'

module.exports = new BaseKonnector(start)

async function start(fields) {
  await this.deactivateAutoSuccessfulLogin()
  await authenticate(fields.username, fields.password)
  await this.notifySuccessfulLogin()

  const documents = await getDocs()

  for (const doc of documents) {
    let oneFile = []

    await request({
      uri: `${baseUrl}/prive/initialiserhabilitation/v1`,
      method: 'POST',
      body: {},
      resolveWithFullResponse: true
    })
    let resp = await request({
      uri: `${baseUrl}/prive/accueilconnecte/v1`,
      resolveWithFullResponse: true
    })
    await request({
      uri: `${baseUrl}/prive/verifiersession/v1`,
      method: 'POST',
      headers: {},
      body: {},
      resolveWithFullResponse: true
    })

    let neededCookies = resp.headers['set-cookie']
    let test = neededCookies[0]

    let cookieSplit = test.split('; ')
    let cookieObject = {}
    cookieSplit.forEach(function(value) {
      let splitResult = value.split('=')
      cookieObject[splitResult[0]] = splitResult[1]
    })

    let stringedAmount = doc.libelle3.replace(',', '.')
    const splitDate = doc.dateEvenement.split('/')
    const formatDay = splitDate[0]
    const formatMonth = splitDate[1]
    const formatYear = splitDate[2]
    doc.dateEvenement = `${formatYear}-${formatMonth}-${formatDay}`

    oneFile.push({
      ...doc,
      date: new Date(doc.dateEvenement),
      vendor: VENDOR,
      vendorRef: doc.evenementId,
      amount: parseFloat(stringedAmount),
      fileurl: `${baseUrl}/prive/telechargerremunerationpaie/v1?documentUuid=${doc.documentUuid}`,
      filename: `${doc.libelle1.toLowerCase().replace(/ /g, '_')}.pdf`,
      requestOptions: {
        headers: {
          'X-XSRF-TOKEN': `${cookieObject['XSRF-TOKEN']}`
        }
      },
      fileAttributes: {
        metadata: {
          datetime: utils.formatDate(new Date()),
          datetimeLabel: 'issueDate',
          contentAuthor: 'ensap.gouv.fr',
          carbonCopy: true,
          qualification: Qualification.getByLabel('pay_sheet')
        }
      }
    })
    log('info', oneFile[0])
    if (oneFile[0].service === 'remuneration') {
      await this.saveBills(oneFile, fields, {
        fileIdAttributes: ['vendorRef'],
        linkBankOperations: false,
        identifiers: ['Ensap'],
        sourceAccountIdentifier: fields.identifiant
      })
    } else {
      log('info', 'is no bill')
      await this.saveFiles(oneFile, fields, {
        fileIdAttributes: ['vendorRef'],
        linkBankOperations: false,
        identifiers: ['Ensap'],
        sourceAccountIdentifier: fields.identifiant
      })
    }
  }
}
async function authenticate(username, password) {
  const resp = await request({
    uri: `${baseUrl}/`,
    method: 'POST',
    Headers: { 'Content-Type': 'application/json' },
    formData: { identifiant: username, secret: password },
    resolveWithFullResponse: true
  })

  const respBody = resp.body

  if (
    respBody.message.includes('Identifiant ou mot de passe erroné') &&
    resp.statusCode != 200
  ) {
    throw new Error(errors.LOGIN_FAILED)
  } else if (
    respBody.message.includes('Authentification OK') &&
    resp.statusCode === 200
  ) {
    return
  } else if (
    respBody.message.includes('Ce compte est temporairement bloqué pendant') &&
    resp.statusCode != 200
  ) {
    log('error', respBody)
    throw new Error('LOGIN_FAILED.TOO_MANY_ATTEMPTS')
  } else {
    log('error', respBody)
    throw new Error(errors.VENDOR_DOWN)
  }
}

async function getDocs() {
  await request({
    uri: `${baseUrl}/prive/initialiserhabilitation/v1`,
    method: 'POST',
    body: {},
    resolveWithFullResponse: true
  })
  const resp = await request({
    uri: `${baseUrl}/prive/accueilconnecte/v1`
  })

  let downloadDocs = []
  for (const evenement of resp.donnee.listeEvenement) {
    downloadDocs.push({
      ...evenement
    })
  }
  return downloadDocs
}
