import {
    Chapter,
    ChapterDetails,
    ContentRating,
    HomeSection,
    HomeSectionType,
    PagedResults,
    PartialSourceManga,
    Request,
    Response,
    SearchRequest,
    SourceInfo,
    SourceIntents,
    SourceManga,
    TagSection,
    HomePageSectionsProviding,
    MangaProviding,
    ChapterProviding,
    SearchResultsProviding,
    BadgeColor,
} from '@paperback/types'

// ─────────────────────────────────────────────────────────────────────────────
// Metadata
// ─────────────────────────────────────────────────────────────────────────────

const BASE_URL = 'https://www.kumanga.com'

export const KuMangaInfo: SourceInfo = {
    version:        '1.0.3',
    name:           'KuManga',
    icon:           'icon.png',
    author:         'alexgpareja',
    description:    'KuManga — Manga, Manhwa y Manhua en Español',
    contentRating:  ContentRating.MATURE,
    websiteBaseURL: BASE_URL,
    language:       'es',
    sourceTags: [
        { text: 'Español', type: BadgeColor.GREY },
    ],
    intents: SourceIntents.MANGA_CHAPTERS
           | SourceIntents.HOMEPAGE_SECTIONS
           | SourceIntents.CLOUDFLARE_BYPASS_REQUIRED,
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function hexDecode(hex: string): string {
    const bytes = hex.match(/.{2}/g) ?? []
    return bytes.map(b => String.fromCharCode(parseInt(b, 16))).join('')
}

function parseMangaUrl(url: string): { id: string; slug: string } | null {
    const m = url.match(/\/manga\/(\d+)\/([^/?#\s]+)/)
    if (!m) return null
    return { id: m[1]!, slug: m[2]! }
}

function buildMangaId(id: string, slug: string): string { return `${id}_${slug}` }
function getNumericId(mangaId: string): string { return mangaId.split('_')[0] ?? mangaId }
function getSlug(mangaId: string): string { return mangaId.split('_').slice(1).join('_') || mangaId }

function parseStatus(t: string): string {
    const l = t.toLowerCase()
    if (l.includes('activo') || l.includes('emisión') || l.includes('ongoing')) return 'Ongoing'
    if (l.includes('finaliz') || l.includes('completed') || l.includes('terminado')) return 'Completed'
    if (l.includes('inconcluso') || l.includes('abandon') || l.includes('hiatus')) return 'Hiatus'
    return 'Unknown'
}

// ─────────────────────────────────────────────────────────────────────────────
// Extensión — patrón correcto 0.8: implements + constructor(private cheerio)
// ─────────────────────────────────────────────────────────────────────────────

export class KuManga implements SearchResultsProviding, MangaProviding, ChapterProviding, HomePageSectionsProviding {

    // Paperback inyecta el cheerio al instanciar la clase
    constructor(private cheerio: CheerioAPI) {}

    RETRIES = 3

    requestManager = App.createRequestManager({
        requestsPerSecond: 3,
        requestTimeout: 20000,
        interceptor: {
            interceptRequest: async (request: Request): Promise<Request> => {
                request.headers = {
                    ...request.headers,
                    'user-agent': await this.requestManager.getDefaultUserAgent(),
                    'referer':    `${BASE_URL}/`,
                }
                return request
            },
            interceptResponse: async (response: Response): Promise<Response> => {
                return response
            }
        }
    })

    async getCloudflareBypassRequestAsync(): Promise<Request> {
        return App.createRequest({
            url:    BASE_URL,
            method: 'GET',
            headers: {
                'referer':    `${BASE_URL}/`,
                'origin':     BASE_URL,
                'user-agent': await this.requestManager.getDefaultUserAgent(),
            }
        })
    }

    // ── getMangaDetails ────────────────────────────────────────────────────

    async getMangaDetails(mangaId: string): Promise<SourceManga> {
        const numId = getNumericId(mangaId)
        const slug  = getSlug(mangaId)

        const response = await this.requestManager.schedule(
            App.createRequest({ url: `${BASE_URL}/manga/${numId}/${slug}`, method: 'GET' }), this.RETRIES
        )
        const $ = this.cheerio.load(response.data)

        const title = $('h1').first().text().trim() || slug.replace(/-/g, ' ')
        const image = $('meta[property="og:image"]').attr('content')
            || `https://static.kumanga.com/manga/6/${numId}.jpg`
        const desc = $('meta[name="description"]').attr('content')
            || $('meta[property="og:description"]').attr('content')
            || ''

        const bodyText = $('body').text()
        const statusMatch = bodyText.match(/\b(Activo|Finalizado|Inconcluso|En emisión|En pausa)\b/)
        const status = statusMatch ? parseStatus(statusMatch[1]!) : 'Unknown'

        const tagItems: ReturnType<typeof App.createTag>[] = []
        const seenTags = new Set<string>()
        $('a[href*="/genero/"]').each((_: number, el: Element) => {
            const href  = $(el).attr('href') ?? ''
            const m     = href.match(/\/genero\/([^/?#]+)/)
            if (!m) return
            const id    = decodeURIComponent(m[1]!).toLowerCase()
            const label = $(el).text().trim()
            if (!label || seenTags.has(id)) return
            seenTags.add(id)
            tagItems.push(App.createTag({ id, label }))
        })

        const tags: TagSection[] = tagItems.length
            ? [App.createTagSection({ id: 'genres', label: 'Géneros', tags: tagItems.slice(0, 20) })]
            : []

        return App.createSourceManga({
            id: mangaId,
            mangaInfo: App.createMangaInfo({ image, titles: [title], desc, status, tags, hentai: false }),
        })
    }

    // ── getChapters ────────────────────────────────────────────────────────

    async getChapters(mangaId: string): Promise<Chapter[]> {
        const numId = getNumericId(mangaId)
        const slug  = getSlug(mangaId)

        const response = await this.requestManager.schedule(
            App.createRequest({ url: `${BASE_URL}/manga/${numId}/${slug}`, method: 'GET' }), this.RETRIES
        )
        const $ = this.cheerio.load(response.data)

        const chapters: Chapter[] = []
        const seen = new Set<string>()

        $('a[href*="/capitulo/"]').each((_: number, el: Element) => {
            const href = $(el).attr('href') ?? ''
            const m    = href.match(/\/capitulo\/(\d+(?:\.\d+)?)/)
            if (!m) return
            const chapId = m[1]!
            if (seen.has(chapId)) return
            seen.add(chapId)
            chapters.push(App.createChapter({
                id:       chapId,
                chapNum:  parseFloat(chapId),
                name:     `Capítulo ${chapId}`,
                langCode: 'es',
            }))
        })

        return chapters.sort((a, b) => b.chapNum - a.chapNum)
    }

    // ── getChapterDetails ──────────────────────────────────────────────────

    async getChapterDetails(mangaId: string, chapterId: string): Promise<ChapterDetails> {
        const numId = getNumericId(mangaId)

        const response = await this.requestManager.schedule(
            App.createRequest({
                url:    `${BASE_URL}/manga/${numId}/capitulo/${chapterId}`,
                method: 'GET',
            }), this.RETRIES
        )
        const $ = this.cheerio.load(response.data)

        const pages: string[] = []
        const seen = new Set<string>()

        // Imágenes con data-src="/img.php?src=HEX" → decodificar hex → URL CDN
        $('img.lozad, img[data-src*="img.php"]').each((_: number, el: Element) => {
            const dataSrc = $(el).attr('data-src') ?? ''
            const hex = dataSrc.split('img.php?src=')[1]?.split('&')[0] ?? ''
            if (!hex) return
            const url = hexDecode(hex)
            if (url.startsWith('http') && !seen.has(url)) {
                seen.add(url)
                pages.push(url)
            }
        })

        // Fallback: buscar en el HTML raw
        if (pages.length === 0) {
            for (const m of ($.html()).matchAll(/img\.php\?src=([0-9A-Fa-f]{20,})/g)) {
                const url = hexDecode(m[1]!)
                if (url.startsWith('http') && !seen.has(url)) {
                    seen.add(url)
                    pages.push(url)
                }
            }
        }

        return App.createChapterDetails({ id: chapterId, mangaId, pages })
    }

    // ── getHomePageSections ────────────────────────────────────────────────

    async getHomePageSections(sectionCallback: (section: HomeSection) => void): Promise<void> {
        const latest  = App.createHomeSection({ id: 'latest',  title: '🔥 Últimas actualizaciones', type: HomeSectionType.singleRowNormal, containsMoreItems: true })
        const popular = App.createHomeSection({ id: 'popular', title: '📈 Populares',               type: HomeSectionType.singleRowLarge,  containsMoreItems: true })

        sectionCallback(latest)
        sectionCallback(popular)

        const response = await this.requestManager.schedule(
            App.createRequest({ url: `${BASE_URL}/mangalist?page=1`, method: 'GET' }), this.RETRIES
        )
        const $ = this.cheerio.load(response.data)
        const tiles = this.parseMangaTiles($)

        latest.items  = tiles.slice(0, 15)
        popular.items = tiles.slice(15, 30)

        sectionCallback(latest)
        sectionCallback(popular)
    }

    async getViewMoreItems(_sectionId: string, metadata: any): Promise<PagedResults> {
        const page = metadata?.page ?? 1
        const response = await this.requestManager.schedule(
            App.createRequest({ url: `${BASE_URL}/mangalist?page=${page}`, method: 'GET' }), this.RETRIES
        )
        const $ = this.cheerio.load(response.data)
        return App.createPagedResults({
            results:  this.parseMangaTiles($),
            metadata: { page: page + 1 },
        })
    }

    // ── getSearchResults ───────────────────────────────────────────────────

    async getSearchResults(query: SearchRequest, metadata: any): Promise<PagedResults> {
        const page   = metadata?.page ?? 1
        const term   = (query.title ?? '').trim()
        const genres = query.includedTags?.map((t: any) => t.id) ?? []

        let url = `${BASE_URL}/mangalist?page=${page}`
        if (term)      url += `&keywords=${encodeURIComponent(term)}`
        if (genres[0]) url += `&genero=${encodeURIComponent(genres[0])}`

        const response = await this.requestManager.schedule(
            App.createRequest({ url, method: 'GET' }), this.RETRIES
        )
        const $ = this.cheerio.load(response.data)
        const manga = this.parseMangaTiles($)

        return App.createPagedResults({
            results:  manga,
            metadata: manga.length > 0 ? { page: page + 1 } : undefined,
        })
    }

    // ── getSearchTags ──────────────────────────────────────────────────────

    async getSearchTags(): Promise<TagSection[]> {
        const genres: [string, string][] = [
            ['accion','Acción'], ['artes-marciales','Artes marciales'], ['aventura','Aventura'],
            ['boys-love','Boys Love'], ['ciencia-ficcion','Ciencia Ficción'], ['comedia','Comedia'],
            ['deportes','Deportes'], ['drama','Drama'], ['ecchi','Ecchi'], ['fantasia','Fantasía'],
            ['gender-bender','Gender Bender'], ['girls-love','Girls Love'], ['gore','Gore'],
            ['harem','Harem'], ['historico','Histórico'], ['horror','Horror'], ['isekai','Isekai'],
            ['josei','Josei'], ['magia','Magia'], ['misterio','Misterio'], ['psicologico','Psicológico'],
            ['recuentos-de-la-vida','Recuentos de la vida'], ['reencarnacion','Reencarnación'],
            ['romance','Romance'], ['seinen','Seinen'], ['shoujo','Shoujo'], ['shounen','Shounen'],
            ['sobrenatural','Sobrenatural'], ['terror','Terror'], ['tragedia','Tragedia'],
        ]
        return [App.createTagSection({
            id:    'genres',
            label: 'Géneros',
            tags:  genres.map(([id, label]) => App.createTag({ id, label })),
        })]
    }

    // ── Parser de tiles ────────────────────────────────────────────────────

    parseMangaTiles($: CheerioAPI): PartialSourceManga[] {
        const tiles: PartialSourceManga[] = []
        const seen = new Set<string>()

        $('li.km-li-crd').each((_: number, el: Element) => {
            const onclick = $(el).attr('onclick') ?? ''
            const urlMatch = onclick.match(/window\.open\(['"]([^'"]+)['"]\)/)
            if (!urlMatch) return

            const parsed = parseMangaUrl(urlMatch[1]!)
            if (!parsed) return

            const { id, slug } = parsed
            const mangaId = buildMangaId(id, slug)
            if (seen.has(mangaId)) return
            seen.add(mangaId)

            const imgEl = $(el).find('img.km-img-crd').first()
            const image = imgEl.attr('src') || `https://static.kumanga.com/manga/6/${id}.jpg`

            let title = imgEl.attr('alt') ?? ''
            if (!title) title = $(el).find('.km-title-p-card').first().text().trim()
            if (!title) title = slug.replace(/-/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase())

            tiles.push(App.createPartialSourceManga({ mangaId, image, title }))
        })

        return tiles
    }
}
