from pydantic import BaseModel, Field, HttpUrl, model_validator


class FacecamDetectionRequest(BaseModel):
    sourceDownloadUrl: HttpUrl
    sourceFilename: str = Field(min_length=1, max_length=255)
    startTimeMs: int = Field(ge=0)
    endTimeMs: int = Field(gt=0)
    samplingIntervalMs: int = Field(default=1000, ge=250, le=10000)
    maxCandidateBoxes: int = Field(default=3, ge=1, le=10)

    @model_validator(mode="after")
    def validate_timing(self):
        if self.endTimeMs <= self.startTimeMs:
            raise ValueError("endTimeMs must be greater than startTimeMs.")
        return self


class FacecamCandidate(BaseModel):
    rank: int
    xPx: int
    yPx: int
    widthPx: int
    heightPx: int
    confidence: int


class FacecamDetectionResponse(BaseModel):
    frameWidth: int
    frameHeight: int
    sampledFrameCount: int
    candidates: list[FacecamCandidate]
    detectionStage: str | None = None
    debugSummary: str | None = None
