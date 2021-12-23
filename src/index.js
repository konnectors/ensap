process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://ea724fef74ee48889c9a788643f96a48@sentry.cozycloud.cc/123'

const {
  BaseKonnector,
  requestFactory,
  log,
  errors
} = require('cozy-konnector-libs')
const DEBUG = false
const request = requestFactory({
  debug: DEBUG,
  json: false,
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
        await this.saveBills(bills, fields, {
          fileIdAttributes: ['vendorRef'],
          linkBankOperations: false
        })
      if (docs.length)
        await this.saveFiles(docs, fields, {
          contentType: 'application/pdf',
          fileIdAttributes: ['vendorRef']
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
          fileIdAttributes: ['vendorRef'],
          linkBankOperations: false
        })
      if (docs.length)
        await this.saveFiles(docs, fields, {
          contentType: 'application/pdf',
          fileIdAttributes: ['vendorRef']
        })
    }
  }
}

async function getYears() {
  const resp = await request.get(`${baseUrl}/prive/accueilconnecte/v1`, {
    json: true
  })
  let listeAnneeRemunerationPension = resp.listeAnneeRemunerationPension
  let listeAnneeRemuneration = resp.listeAnneeRemuneration
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
        vendorRef: uuid
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
        type: 'income'
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
