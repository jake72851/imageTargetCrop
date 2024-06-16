import vision from '@google-cloud/vision';
import fs from 'fs';
import sharp from 'sharp';
import AWS from 'aws-sdk';
import url from 'url';

const s3 = new AWS.S3();
const bucket = 'vplate-s3';

export const handler = async (event) => {
  try {
    console.info('event =', event);

    // s3이미지 불러오기
    const imgUrl = event.image_path;
    const parsedUrl = url.parse(imgUrl);
    const path = parsedUrl.path;
    const s3Key = path.substring(1);
    console.info('s3Key =', s3Key);

    const params = {
      Bucket: bucket,
      Key: s3Key,
    };
    const s3Image = await s3.getObject(params).promise();
    console.info("s3Image =", s3Image);

    const contentType = s3Image.ContentType;
    const s3ImageBuffer = s3Image.Body;

    // 이미지 정보 확인
    const startImage = sharp(s3ImageBuffer);
    const metadata = await startImage.metadata();
    console.info("startImage.metadata() =", metadata);

    const targetWidth = event.new_width;
    const targetHeight = event.new_height;

    const assetInfo = {};
    let cropStatus = false; // 크롭여부 확인
    let productStatus = false; // 제품인식여부

    // google vision api setting
    const keyFilename = "vplate-render-1132b2423934.json";
    const client = new vision.ImageAnnotatorClient({ keyFilename });

    // event.asset = null 이면 vision api 적용 필요
    if (!event.asset) {
      console.info("event.asset = null 인 경우임!");

      // 이미지에서 제품위치 정보 확인
      const [result] = await client.objectLocalization(s3ImageBuffer);
      console.info("result =", result);

      const objects = result.localizedObjectAnnotations;

      if (objects && objects.length === 1) {
        console.info('제품 하나만 잡힘!');
        console.info(`Name: ${objects[0].name}`);
        console.info(`Confidence: ${objects[0].score}`);

        const vertices = objects[0].boundingPoly.normalizedVertices;

        let padding = 0;
        let xRate = padding / metadata.width;
        let yRate = padding / metadata.height;
        console.info('xRate =', xRate);
        console.info('yRate =', yRate);

        const checkLeft = vertices[0].x - xRate;
        const checkTop = vertices[0].y - yRate;
        const checkLeft1 = Math.max(vertices[0].x - xRate, 0);
        const checkTop1 = Math.max(vertices[0].y - yRate, 0);
        const checkWidth = vertices[2].x - vertices[0].x + xRate * 2;
        const checkHeight = vertices[2].y - vertices[0].y + yRate * 2;

        if (checkLeft < 0 || checkTop < 0 || (checkLeft1 + checkWidth) > 1 || (checkTop1 + checkHeight) > 1) {
          padding = 0;
          xRate = 0;
          yRate = 0;
        }
        console.info('padding =', padding);

        const bounds = {
          left: Math.max(vertices[0].x - xRate, 0),
          top: Math.max(vertices[0].y - yRate, 0),
          width: Math.min(vertices[2].x - vertices[0].x + xRate * 2, 1),
          height: Math.min(vertices[2].y - vertices[0].y + yRate * 2, 1),
        };

        assetInfo.left = Math.round(bounds.left * metadata.width);
        assetInfo.top = Math.round(bounds.top * metadata.height);
        assetInfo.width = Math.round(bounds.width * metadata.width);
        assetInfo.height = Math.round(bounds.height * metadata.height);

        productStatus = true;

      } else if (objects && objects.length > 0) {

        let left = 1;
        let top = 1;
        let width = 0;
        let height = 0;

        objects.forEach(item => {
          item.boundingPoly.normalizedVertices.forEach((value, index) => {
            if (index === 0) {
              left = Math.min(left, Number(value.x));
              top = Math.min(top, value.y);
            } else if (index === 2) {
              width = Math.max(width, value.x);
              height = Math.max(height, value.y);
            }
          });
        });

        assetInfo.left = Math.round(left * metadata.width);
        assetInfo.top = Math.round(top * metadata.height);
        assetInfo.width = Math.round((width - left) * metadata.width);
        assetInfo.height = Math.round((height - top) * metadata.height);

        productStatus = true;
      } else {
        console.info('제품 인지 못함!');
        assetInfo.left = 0;
        assetInfo.top = 0;
        assetInfo.width = metadata.width;
        assetInfo.height = metadata.height;
      }

    } else {
      assetInfo.left = event.asset.left;
      assetInfo.top = event.asset.top;
      assetInfo.width = event.asset.width;
      assetInfo.height = event.asset.height;
    }

    if (productStatus) {
      console.info('텍스트인식 시작!');
      const [result] = await client.textDetection(s3ImageBuffer);
      const detections = result.textAnnotations;

      if (detections && detections.length > 0) {

        const rect1 = [
          [assetInfo.left, assetInfo.top],
          [assetInfo.left + assetInfo.width, assetInfo.top],
          [assetInfo.left + assetInfo.width, assetInfo.top + assetInfo.height],
          [assetInfo.left, assetInfo.top + assetInfo.height],
        ];

        for (var i = 1; i < detections.length; i++) {

          const object = detections[i].boundingPoly.vertices;

          const rect2 = [
            [object[0].x, object[0].y],
            [object[1].x, object[1].y],
            [object[2].x, object[2].y],
            [object[3].x, object[3].y],
          ];

          if (await isContained(rect1, rect2)) {
            console.info('영역 포함');
          } else if (await isOverlap(rect1, rect2)) {
            console.info('영역 겹침');
            assetInfo.left = 0;
            assetInfo.top = 0;
            assetInfo.width = metadata.width;
            assetInfo.height = metadata.height;
          } else {
            console.info('영역 별도');
          }
        }
      } else {
        console.info('텍스트인식 안됨!');
      }
    }

    let cropImageBuffer;
    if (cropStatus) {
      console.info('제품 크롭 실행!');
      cropImageBuffer = await startImage.extract({
        left: assetInfo.left,
        top: assetInfo.top,
        width: Math.round(assetInfo.width - 2),
        height: Math.round(assetInfo.height - 2),
      }).toBuffer();
    } else {
      cropImageBuffer = await startImage.toBuffer();
    }

    const cropResult = sharp(cropImageBuffer);
    const metadata_re = await cropResult.metadata();

    const aspect_ratio_width = targetWidth / metadata_re.width;
    const aspect_ratio_height = targetHeight / metadata_re.height;

    const scaling_factor = Math.max(aspect_ratio_width, aspect_ratio_height);

    const new_width1 = Math.round(metadata_re.width * scaling_factor);
    const new_height1 = Math.round(metadata_re.height * scaling_factor);

    const resizeResultBuffer = await cropResult.resize(new_width1, new_height1).toBuffer();

    const resizeResult = sharp(resizeResultBuffer);
    const metadata_final = await resizeResult.metadata();

    const cropCenterX = Math.round((assetInfo.left * scaling_factor) + ((assetInfo.width - 2) * scaling_factor) / 2);
    const cropCenterY = Math.round((assetInfo.top * scaling_factor) + ((assetInfo.height - 2) * scaling_factor) / 2);

    const startX = Math.floor(cropCenterX - (targetWidth / 2));
    const startY = Math.floor(cropCenterY - (targetHeight / 2));

    const adjustedStartX = Math.max(0, startX);
    const adjustedStartY = Math.max(0, startY);

    const adjustedWidth = Math.min(metadata_final.width - adjustedStartX, targetWidth);
    const adjustedHeight = Math.min(metadata_final.height - adjustedStartY, targetHeight);

    const finalImageBuffer = await resizeResult.extract({
      left: adjustedStartX,
      top: adjustedStartY,
      width: adjustedWidth,
      height: adjustedHeight,
    }).toBuffer();

    const finalImage = sharp(finalImageBuffer);
    const resMetadata = await finalImage.metadata();
    const sizeInMB = resMetadata.size / (1024 * 1024);

    const uploadResult = await s3.putObject({
      Bucket: bucket,
      Key: event.s3_path.slice(1),
      Body: finalImageBuffer,
      ACL: 'public-read',
      ContentType: contentType,
    }).promise();

    const response = {
      statusCode: 200,
      isSuccess: true,
      url: 'https://' + bucket + '.s3.amazonaws.com' + event.s3_path,
      width: adjustedWidth,
      height: adjustedHeight,
      file_size: sizeInMB.toFixed(2),
      file_extension: resMetadata.format,
    };
    return response;
  } catch (error) {
    console.error('error =', error);
    return {
      isSuccess: false,
    };
  }
};

async function isOverlap(rect1, rect2) {
  if (
    Math.max(rect1[0][0], rect1[1][0], rect1[2][0], rect1[3][0]) <
    Math.min(rect2[0][0], rect2[1][0], rect2[2][0], rect2[3][0]) ||
    Math.max(rect2[0][0], rect2[1][0], rect2[2][0], rect2[3][0]) <
    Math.min(rect1[0][0], rect1[1][0], rect1[2][0], rect1[3][0]) ||
    Math.max(rect1[0][1], rect1[1][1], rect1[2][1], rect1[3][1]) <
    Math.min(rect2[0][1], rect2[1][1], rect2[2][1], rect2[3][1]) ||
    Math.max(rect2[0][1], rect2[1][1], rect2[2][1], rect2[3][1]) <
    Math.min(rect1[0][1], rect1[1][1], rect1[2][1], rect1[3][1])
  ) {
    return false;
  }
  return true;
}

async function isContained(rect1, rect2) {
  for (let i = 0; i < 4; i++) {
    if (
      rect2[i][0] <
      Math.min(rect1[0][0], rect1[1][0], rect1[2][0], rect1[3][0]) ||
      rect2[i][0] >
      Math.max(rect1[0][0], rect1[1][0], rect1[2][0], rect1[3][0]) ||
      rect2[i][1] <
      Math.min(rect1[0][1], rect1[1][1], rect1[2][1], rect1[3][1]) ||
      rect2[i][1] >
      Math.max(rect1[0][1], rect1[1][1], rect1[2][1], rect1[3][1])
    ) {
      return false;
    }
  }
  return true;
}
