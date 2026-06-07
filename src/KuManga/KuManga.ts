import {
    Chapter,
    ChapterDetails,
    ContentRating,
    HomeSection,
    HomeSectionType,
    PagedResults,
    SearchRequest,
    Source,
    SourceIntents,
    SourceManga,
    TagSection,
} from '@paperback/types'

// ─────────────────────────────────────────────────────────────────────────────
// Metadata
// ─────────────────────────────────────────────────────────────────────────────

const BASE_URL = 'https://www.kumanga.com'

export const KuMangaInfo = {
    version:        '1.0.0',
    name:           'KuManga',
    icon:           'icon.png',
    author:         'alexgpareja',
    description:    'KuManga — Manga en Español Online',
    contentRating:  ContentRating.MATURE,
    websiteBaseURL: BASE_URL,
    language:       'es',
    intents:        SourceIntents.MANGA_CHAPTERS
                  | SourceIntents.HOMEPAGE_SECTIONS
                  | SourceIntents.CLOUDFLARE_BYPASS_REQUIRED,
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Decodifica la URL real desde el parámetro hex de img.php.
 *
 * KuManga usa img.php?src=HEX donde HEX es la URL real en hexadecimal.
 * Ejemplo: "68747470733A2F2F..." → "https://s98.manga.tel/manga/6440/700702/1.jpg"
 *
 * Las URLs del CDN manga.tel funcionan directamente sin Cloudflare,
 * por lo que las usamos en lugar del proxy de kumanga.
 */
function decodeImgUrl(hex: string): string {
    const bytes = hex.match(/.{2}/g) ?? []
    return bytes.map(b => String.fromCharCode(parseInt(b, 16))).join('')
}

/**
 * Extrae todas las URLs de páginas del HTML del lector.
 * Busca patrones img.php?src=HEX y decodifica cada uno.
 */
function extractPageUrls($: ReturnType<typeof Application.loadCheerio>): string[] {
    const pages: string[] = []
    const seen = new Set<string>()

    // Buscar todos los atributos src/data-src que contienen img.php?src=
    $('img, [data-src]').each((_: unknown, el: unknown) => {
        for (const attr of ['src', 'data-src', 'data-original', 'data-lazy']) {
            const val: string = ($(el as never) as never).attr(attr) ?? ''
            let hex = ''

            if (val.includes('img.php?src=')) {
                hex = val.split('img.php?src=')[1]?.split('&')[0] ?? ''
            } else if (val.includes('manga.tel')) {
                // URL directa del CDN — ya usable
                if (!seen.has(val)) { seen.add(val); pages.push(val) }
                continue
            }

            if (hex) {
                const decoded = decodeImgUrl(hex)
                if (decoded.startsWith('http') && !seen.has(decoded)) {
                    seen.add(decoded)
                    pages.push(decoded)
                }
            }
        }
    })

    // Fallback: buscar en atributos src de scripts inline (var images = [...])
    if (pages.length === 0) {
        const html = $.html()
        const matches = [...html.matchAll(/img\.php\?src=([0-9A-Fa-f]{20,})/g)]
        for (const m of matches) {
            const decoded = decodeImgUrl(m[1]!)
            if (decoded.startsWith('http') && !seen.has(decoded)) {
                seen.add(decoded)
                pages.push(decoded)
            }
        }
    }

    return pages
}

/**
 * Extrae el ID numérico y slug de una URL de manga.
 * /manga/6440/secret-class → { id: '6440', slug: 'secret-class' }
 */
function parseMangaUrl(url: string): { id: string; slug: string } | null {
    const m = url.match(/\/manga\/(\d+)\/([^/?#]+)/)
    if (!m) return null
    return { id: m[1]!, slug: m[2]! }
}

/** El mangaId que guardamos internamente es "{id}_{slug}" */
function buildMangaId(id: string, slug: string): string {
    return `${id}_${slug}`
}

/** Recuperar el ID numérico desde el mangaId interno */
function getNumericId(mangaId: string): string {
    return mangaId.split('_')[0] ?? mangaId
}

/** Recuperar el slug desde el mangaId interno */
function getSlug(mangaId: string): string {
    return mangaId.split('_').slice(1).join('_') || mangaId
}

function parseStatus(text: string): string {
    const t = text.toLowerCase()
    if (t.includes('activo') || t.includes('ongoing') || t.includes('publicando')) return 'Ongoing'
    if (t.includes('finaliz') || t.includes('completed') || t.includes('terminado')) return 'Completed'
    if (t.includes('abandon') || t.includes('hiatus') || t.includes('pausa')) return 'Hiatus'
    return 'Unknown'
}

// ─────────────────────────────────────────────────────────────────────────────
// Clase principal
// ─────────────────────────────────────────────────────────────────────────────

export class KuManga extends Source {

    readonly requestManager = App.createRequestManager({
        requestsPerSecond: 3,
        requestTimeout:    20000,
    })

    // Cloudflare bypass — Paperback abrirá el WebView una vez para resolver el challenge
    async getCloudflareBypassRequestAsync() {
        return App.createRequest({ url: BASE_URL, method: 'GET' })
    }

    // ── getMangaDetails ────────────────────────────────────────────────────
    // URL: https://www.kumanga.com/manga/{numericId}/{slug}
    // mangaId interno: "{numericId}_{slug}"

    async getMangaDetails(mangaId: string): Promise<SourceManga> {
        const numId = getNumericId(mangaId)
        const slug  = getSlug(mangaId)
        const url   = `${BASE_URL}/manga/${numId}/${slug}`

        const resp = await this.requestManager.schedule(
            App.createRequest({ url, method: 'GET' }), 2
        )
        const $ = this.cheerio.load(resp.data ?? '')

        // Título
        const title = $('h1').first().text().trim()
            || $('meta[property="og:title"]').attr('content')?.split('|')[0]?.trim()
            || slug.replace(/-/g, ' ')

        // Portada
        const image = $('meta[property="og:image"]').attr('content')
            || $('img[class*="cover"], img[class*="portada"], .manga-cover img, .series-cover img').first().attr('src')
            || `${BASE_URL}/img/series/${numId}.jpg`

        // Descripción
        const desc = $('meta[name="description"]').attr('content')
            || $('meta[property="og:description"]').attr('content')
            || $('[class*="sinopsis"], [class*="desc"], [class*="synopsis"]').first().text().trim()
            || ''

        // Estado
        const bodyText = $('body').text()
        const statusMatch = bodyText.match(/\b(activo|finalizado|abandonado|hiatus|en pausa|ongoing|completed)\b/i)
        const status = statusMatch ? parseStatus(statusMatch[1]!) : 'Unknown'

        // Géneros — buscar enlaces a /genero/ o /categoria/ o similar
        const tagItems: ReturnType<typeof App.createTag>[] = []
        const seenTags = new Set<string>()

        $('a[href*="/genero/"], a[href*="/genre/"], a[href*="/categoria/"], a[href*="/tag/"]').each((_: unknown, el: unknown) => {
            const href  = $(el as never).attr('href') ?? ''
            const m     = href.match(/\/(genero|genre|categoria|tag)\/([^/?#]+)/)
            if (!m) return
            const id    = m[2]!
            const label = $(el as never).text().trim()
            if (!label || seenTags.has(id)) return
            seenTags.add(id)
            tagItems.push(App.createTag({ id, label }))
        })

        const tags: TagSection[] = tagItems.length
            ? [App.createTagSection({ id: 'genres', label: 'Géneros', tags: tagItems.slice(0, 20) })]
            : []

        return App.createSourceManga({
            id: mangaId,
            mangaInfo: App.createMangaInfo({
                image,
                titles: [title],
                desc,
                status,
                tags,
                hentai: false,
            }),
        })
    }

    // ── getChapters ────────────────────────────────────────────────────────
    // Los capítulos están en la página de detalle del manga.
    // Cada capítulo enlaza a /manga/leer/{chapterId}

    async getChapters(mangaId: string): Promise<Chapter[]> {
        const numId = getNumericId(mangaId)
        const slug  = getSlug(mangaId)

        const resp = await this.requestManager.schedule(
            App.createRequest({ url: `${BASE_URL}/manga/${numId}/${slug}`, method: 'GET' }), 2
        )
        const $ = this.cheerio.load(resp.data ?? '')

        const chapters: Chapter[] = []
        const seen = new Set<string>()

        // Cada capítulo enlaza a /manga/leer/{chapterId}
        $('a[href*="/manga/leer/"]').each((_: unknown, el: unknown) => {
            const href = $(el as never).attr('href') ?? ''
            const m    = href.match(/\/manga\/leer\/(\d+)/)
            if (!m) return

            const chapId = m[1]!
            if (seen.has(chapId)) return
            seen.add(chapId)

            // Extraer número de capítulo del texto del enlace
            const text     = $(el as never).text().trim()
            const numMatch = text.match(/[\d]+(?:[.,]\d+)?/)
            const chapNum  = numMatch ? parseFloat(numMatch[0].replace(',', '.')) : chapters.length + 1

            // Extraer fecha si está disponible
            const parentText = $(el as never).closest('li, tr, div').text()
            const dateMatch  = parentText.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/)
            let time: Date | undefined
            if (dateMatch) {
                time = new Date(`${dateMatch[3]}-${dateMatch[2]?.padStart(2,'0')}-${dateMatch[1]?.padStart(2,'0')}`)
                if (isNaN(time.getTime())) time = undefined
            }

            chapters.push(App.createChapter({
                id:       chapId,
                chapNum,
                name:     `Capítulo ${chapNum}`,
                langCode: 'es',
                ...(time ? { time } : {}),
            }))
        })

        // Ordenar descendente (más reciente primero)
        return chapters.sort((a, b) => b.chapNum - a.chapNum)
    }

    // ── getChapterDetails ──────────────────────────────────────────────────
    // URL: https://www.kumanga.com/manga/leer/{chapterId}
    //
    // Las imágenes usan img.php?src=HEX donde HEX es la URL real del CDN.
    // El CDN manga.tel funciona DIRECTAMENTE sin Cloudflare.
    // Decodificamos el hex y usamos las URLs directas del CDN.

    async getChapterDetails(mangaId: string, chapterId: string): Promise<ChapterDetails> {
        const resp = await this.requestManager.schedule(
            App.createRequest({
                url: `${BASE_URL}/manga/leer/${chapterId}`,
                method: 'GET',
            }), 2
        )
        const $ = this.cheerio.load(resp.data ?? '')

        const pages = extractPageUrls($)

        return App.createChapterDetails({ id: chapterId, mangaId, pages })
    }

    // ── getHomePageSections ────────────────────────────────────────────────

    async getHomePageSections(sectionCallback: (section: HomeSection) => void): Promise<void> {
        const recent  = App.createHomeSection({ id: 'recent',  title: '🔥 Últimas actualizaciones', type: HomeSectionType.singleRowNormal, containsMoreItems: true })
        const popular = App.createHomeSection({ id: 'popular', title: '📈 Más Populares',           type: HomeSectionType.singleRowLarge,  containsMoreItems: true })

        sectionCallback(recent)
        sectionCallback(popular)

        // Cargar la lista principal
        const resp = await this.requestManager.schedule(
            App.createRequest({ url: `${BASE_URL}/mangalist?page=1`, method: 'GET' }), 2
        )
        const $ = this.cheerio.load(resp.data ?? '')

        const tiles = parseMangaTiles($)
        recent.items  = tiles.slice(0, 15)
        popular.items = tiles.slice(15, 30)

        sectionCallback(recent)
        sectionCallback(popular)
    }

    async getViewMoreItems(sectionId: string, metadata: { page?: number }): Promise<PagedResults> {
        const page = metadata?.page ?? 1
        const resp = await this.requestManager.schedule(
            App.createRequest({ url: `${BASE_URL}/mangalist?page=${page}`, method: 'GET' }), 2
        )
        const $ = this.cheerio.load(resp.data ?? '')

        const hasNext = $('a').toArray().some((el: unknown) => {
            const text = $(el as never).text().trim().toLowerCase()
            return text === 'siguiente' || text === 'next' || text === '»'
        })

        return App.createPagedResults({
            results:  parseMangaTiles($),
            metadata: hasNext ? { page: page + 1 } : undefined,
        })
    }

    // ── getSearchResults ───────────────────────────────────────────────────

    async getSearchResults(query: SearchRequest, metadata: { page?: number }): Promise<PagedResults> {
        const page    = metadata?.page ?? 1
        const term    = (query.title ?? '').trim()
        const genres  = query.includedTags?.map(t => t.id) ?? []

        let url: string
        if (term) {
            // Búsqueda por título
            url = `${BASE_URL}/mangalist?search=${encodeURIComponent(term)}&page=${page}`
        } else if (genres.length > 0) {
            // Filtro por género
            url = `${BASE_URL}/genero/${genres[0]!}?page=${page}`
        } else {
            url = `${BASE_URL}/mangalist?page=${page}`
        }

        const resp = await this.requestManager.schedule(
            App.createRequest({ url, method: 'GET' }), 2
        )
        const $ = this.cheerio.load(resp.data ?? '')

        const hasNext = $('a').toArray().some((el: unknown) => {
            const text = $(el as never).text().trim().toLowerCase()
            return text === 'siguiente' || text === 'next' || text === '»'
        })

        return App.createPagedResults({
            results:  parseMangaTiles($),
            metadata: hasNext ? { page: page + 1 } : undefined,
        })
    }

    // ── getSearchTags ──────────────────────────────────────────────────────

    async getSearchTags(): Promise<TagSection[]> {
        const genres: [string, string][] = [
            ['accion','Acción'],['aventura','Aventura'],['comedia','Comedia'],
            ['drama','Drama'],['fantasia','Fantasía'],['romance','Romance'],
            ['ciencia-ficcion','Ciencia Ficción'],['terror','Terror'],
            ['misterio','Misterio'],['seinen','Seinen'],['shounen','Shōnen'],
            ['shoujo','Shōjo'],['josei','Josei'],['ecchi','Ecchi'],
            ['harem','Harem'],['isekai','Isekai'],['slice-of-life','Slice of Life'],
            ['supernatural','Sobrenatural'],['psicologico','Psicológico'],
            ['historico','Histórico'],['artes-marciales','Artes Marciales'],
            ['gore','Gore'],['yaoi','Yaoi (Boys Love)'],['yuri','Yuri (Girls Love)'],
        ]
        return [
            App.createTagSection({
                id:    'genres',
                label: 'Géneros',
                tags:  genres.map(([id, label]) => App.createTag({ id, label })),
            }),
        ]
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Parser de listados
// ─────────────────────────────────────────────────────────────────────────────

function parseMangaTiles($: ReturnType<never>): ReturnType<typeof App.createPartialSourceManga>[] {
    const tiles: ReturnType<typeof App.createPartialSourceManga>[] = []
    const seen  = new Set<string>()

    // Buscar enlaces a páginas de manga: /manga/{id}/{slug}
    ;($('a[href*="/manga/"]') as ReturnType<never>).each((_: unknown, el: unknown) => {
        const href = ($ as never)(el as never).attr('href') ?? ''
        const parsed = parseMangaUrl(href)
        if (!parsed) return

        const { id, slug } = parsed
        const mangaId = buildMangaId(id, slug)
        if (seen.has(mangaId)) return

        // Imagen: buscar img dentro del enlace (con lazy loading)
        const imgEl = ($ as never)(el as never).find('img').first()
        let image = imgEl.attr('src') || imgEl.attr('data-src') || imgEl.attr('data-original') || imgEl.attr('data-lazy') || ''

        // Si la imagen pasa por el proxy hex, decodificarla
        if (image.includes('img.php?src=')) {
            const hex = image.split('img.php?src=')[1]?.split('&')[0] ?? ''
            if (hex) image = decodeImgUrl(hex)
        }

        // Fallback: intentar URL predecible de portada
        if (!image.startsWith('http')) {
            image = `${BASE_URL}/img/series/${id}.jpg`
        }

        // Título
        let title = (imgEl.attr('alt') ?? '').trim()
        if (!title) title = ($ as never)(el as never).find('h2,h3,h4,h5,.title,.manga-title').first().text().trim()
        if (!title) title = slug.replace(/-/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase())

        // Limpiar título duplicado
        if (title.length > 6) {
            const half = Math.floor(title.length / 2)
            if (title.slice(0, half).trim() === title.slice(half).trim()) {
                title = title.slice(0, half).trim()
            }
        }

        seen.add(mangaId)
        tiles.push(App.createPartialSourceManga({ mangaId, image, title }))
    })

    return tiles
}
