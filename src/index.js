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

const crypto = require('crypto')

const VENDOR = 'Ensap'
const baseUrl = 'https://ensap.gouv.fr'

module.exports = new BaseKonnector(start)

async function start(fields) {
  await this.deactivateAutoSuccessfulLogin()
  await authenticate(fields.login, fields.password)
  await this.notifySuccessfulLogin()

  const { yearsPaie, yearsPension } = await getYears()
  if (yearsPaie) {
    log('info', 'Found Remuneration type docs, fetching them...')
    for (const yearPaie of yearsPaie) {
      const files = await fetchFiles(yearPaie)
      const { docs, bills } = await parseDocuments(files, 'paie')
      if (bills.length)
        // We update the isRefund attribute if missing due to 1.5.0
        await this.saveBills(bills, fields, {
          fileIdAttributes: ['vendorRef'],
          identifiers: ['ddfip', 'drfip', 'paye', 'remuneration'],
          shouldUpdate: function (newBill, dbEntry) {
            const result = newBill.isRefund && !dbEntry.isRefund
            return result
          }
        })
      if (docs.length)
        await this.saveFiles(docs, fields, {
          contentType: 'application/pdf',
          fileIdAttributes: ['vendorRef'],
          identifiers: ['ddfip', 'drfip', 'paye', 'remuneration']
        })
    }
  }
  if (yearsPension) {
    log('info', 'Found Pension type docs, fetching them...')
    for (const yearPension of yearsPension) {
      const files = await fetchFilesPension(yearPension)
      const { docs, bills } = await parseDocuments(files, 'pension')
      if (bills.length)
        await this.saveBills(bills, fields, {
          fileIdAttributes: ['vendorRef']
        })
      if (docs.length)
        await this.saveFiles(docs, fields, {
          contentType: 'application/pdf',
          fileIdAttributes: ['vendorRef']
        })
    }
  }
}
async function authenticate(login, password) {
  const resp = await request({
    uri: `${baseUrl}/`,
    method: 'POST',
    Headers: { 'Content-Type': 'application/json' },
    formData: { identifiant: login, secret: password },
    resolveWithFullResponse: true
  })

  const respBody = resp.body
  if (respBody.message.includes('ou mot de passe')) {
    throw new Error(errors.LOGIN_FAILED)
  } else if (
    respBody.message.includes('Authentification OK') &&
    resp.statusCode === 200
  ) {
    return
  } else if (respBody.message.includes('bloqué')) {
    log('error', respBody)
    throw new Error('LOGIN_FAILED.TOO_MANY_ATTEMPTS')
  } else {
    log('error', respBody)
    throw new Error(errors.VENDOR_DOWN)
  }
}

async function getYears() {
  const resp = await request({
    uri: `${baseUrl}/prive/initialiserhabilitation/v1`,
    method: 'POST',
    body: {},
    resolveWithFullResponse: true
  })
  let listeAnneeRemunerationPension = resp.body.listeAnneeRemunerationPension
  let listeAnneeRemuneration = resp.body.listeAnneeRemuneration
  if (listeAnneeRemuneration && listeAnneeRemuneration.reverse) {
    listeAnneeRemuneration = listeAnneeRemuneration.sort().reverse()
  }
  if (listeAnneeRemunerationPension && listeAnneeRemunerationPension.reverse) {
    listeAnneeRemunerationPension = listeAnneeRemunerationPension
      .sort()
      .reverse()
  }

  if (listeAnneeRemuneration || listeAnneeRemunerationPension) {
    return {
      yearsPaie: listeAnneeRemuneration,
      yearsPension: listeAnneeRemunerationPension
    }
  } else {
    log('warn', 'could not find year of remuneration')
    return {}
  }
}

function fetchFiles(year) {
  log('info', `Fetching files paie for year ${year}`)
  return request.get(`${baseUrl}/prive/remunerationpaie/v1?annee=${year}`, {
    json: true
  })
}

function fetchFilesPension(year) {
  log('info', `Fetching files pension for year ${year}`)
  return request.get(`${baseUrl}/prive/remunerationpension/v1?annee=${year}`, {
    json: true
  })
}

async function parseDocuments(files, type = 'paie') {
  const docs = []
  const bills = []
  for (const file of files) {
    // For each file get the pdf url and metadata
    const uuid = file.documentUuid
    // Switching url if we have pension documents
    let fileurl = `${baseUrl}/prive/telechargerremunerationpaie/v1?documentUuid=${uuid}`
    if (type === 'pension') {
      fileurl = `${baseUrl}/prive/telechargerremunerationpension/v1?documentUuid=${uuid}`
    }
    let filename = file.nomDocument
    // Try to replace _XX_ known type_
    filename = filename.replace(/_AF_/, '_Attestation_fiscale_')
    filename = filename.replace(/_AFENS_/, '_Attestation_fiscale_')
    filename = filename.replace(/_AFPENS_/, '_Attestation_fiscale_')
    filename = filename.replace(/_DR_/, '_Décompte_de_rappel_')
    if (type === 'pension') {
      filename = filename.replace(/_BP_/, '_Bulletin_de_pension_')
      filename = filename.replace(/_BPENS_/, '_Bulletin_de_pension_')
    } else {
      filename = filename.replace(/_BP_/, '_Bulletin_de_paie_')
      filename = filename.replace(/_BPENS_/, '_Bulletin_de_paie_')
    }
    filename = filename.replace(
      /\.pdf$/,
      `_${crypto
        .createHash('sha1')
        .update(uuid)
        .digest('hex')
        .substr(0, 5)}.pdf`
    )

    // Date is set to 22 of the month for easier matching, if not BP is always at 1st
    let datePlus21 = new Date(file.dateDocument)
    datePlus21.setDate(datePlus21.getDate() + 21)
    const amount = parseFloat(file.libelle3.replace(' ', '').replace(',', '.'))
    const vendor = VENDOR

    // This doc have no amount in libelle3, make a file only.
    if (
      file.icone === 'rappel' ||
      file.icone === 'attestation' ||
      file.icone === 'attestation-pension'
    ) {
      const doc = {
        fileurl,
        filename,
        vendorRef: uuid,
        fileAttributes: {
          metadata: {
            datetime: utils.formatDate(new Date()),
            datetimeLabel: 'issueDate',
            contentAuthor: 'ensap.gouv.fr',
            carbonCopy: true,
            qualification: Qualification.getByLabel('other_revenue')
          }
        }
      }
      docs.push(doc)
    } else if (file.icone === 'document' || file.icone === 'document-pension') {
      // This doc have amount, it's a bill !
      const doc = {
        date: datePlus21,
        fileurl,
        filename,
        amount,
        isRefund: true,
        vendor,
        vendorRef: uuid,
        type: 'income',
        fileAttributes: {
          metadata: {
            datetime: utils.formatDate(new Date()),
            datetimeLabel: 'issueDate',
            contentAuthor: 'ensap.gouv.fr',
            carbonCopy: true,
            qualification: Qualification.getByLabel('pay_sheet')
          }
        }
      }
      bills.push(doc)
    } else {
      log(
        'warn',
        `Unkown type for one doc, discarding this one : ${file.icone}`
      )
    }
  }
  return { docs, bills }
}
